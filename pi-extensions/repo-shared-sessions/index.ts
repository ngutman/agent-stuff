import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager, SessionInfo, Theme } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import { basename, resolve } from "node:path";

type RepoIdentity = {
	key: string;
	display: string;
	remote?: string;
	topLevel?: string;
};

type ResumeMode = "pick" | "latest";

type SessionCandidate = {
	session: SessionInfo;
	title: string;
	meta: string;
	search: string;
};

const GIT_TIMEOUT_MS = 4_000;
const MAX_TITLE_LEN = 70;
const SELECTOR_MAX_VISIBLE = 12;

function normalizeRemote(raw: string | undefined): string | undefined {
	if (!raw) return undefined;

	let remote = raw.trim();
	if (!remote) return undefined;

	if (remote.startsWith("git@")) {
		const rest = remote.slice(4);
		const colon = rest.indexOf(":");
		remote = colon >= 0 ? `${rest.slice(0, colon)}/${rest.slice(colon + 1)}` : rest;
	} else {
		remote = remote.replace(/^[a-z]+:\/\//i, "");
		remote = remote.replace(/^[^@]+@/, "");
	}

	remote = remote.replace(/[?#].*$/, "");
	remote = remote.replace(/\\/g, "/");
	remote = remote.replace(/\.git$/i, "");
	remote = remote.replace(/\/+$/, "");

	return remote.toLowerCase() || undefined;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max = MAX_TITLE_LEN): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function shortenPath(path: string): string {
	const home = process.env.HOME;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 60_000) return "just now";

	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;

	const years = Math.floor(months / 12);
	return `${years}y ago`;
}

function sessionTitle(session: SessionInfo): string {
	const source = oneLine(session.name?.trim() || session.firstMessage?.trim() || "(empty session)");
	return clip(source);
}

function sameRepo(a: RepoIdentity, b: RepoIdentity): boolean {
	if (a.remote && b.remote) return a.remote === b.remote;
	if (a.topLevel && b.topLevel) return a.topLevel === b.topLevel;
	return a.key === b.key;
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const res = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
		if (res.code !== 0) return undefined;
		const out = res.stdout.trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

function createRepoResolver(pi: ExtensionAPI) {
	const cache = new Map<string, Promise<RepoIdentity | null>>();

	return async (cwd: string): Promise<RepoIdentity | null> => {
		const key = resolve(cwd);
		const cached = cache.get(key);
		if (cached) return cached;

		const task = (async () => {
			const topLevelRaw = await gitOutput(pi, key, ["rev-parse", "--show-toplevel"]);
			if (!topLevelRaw) return null;

			const topLevel = resolve(topLevelRaw);
			const remoteRaw = await gitOutput(pi, key, ["config", "--get", "remote.origin.url"]);
			const remote = normalizeRemote(remoteRaw);

			if (remote) {
				return {
					key: `remote:${remote}`,
					display: remote,
					remote,
					topLevel,
				};
			}

			const repoName = basename(topLevel);
			return {
				key: `top:${topLevel}`,
				display: repoName,
				topLevel,
			};
		})();

		cache.set(key, task);
		return task;
	};
}

async function getSharedRepoSessions(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ repo: RepoIdentity; sessions: SessionInfo[] }> {
	const resolveRepo = createRepoResolver(pi);
	const currentRepo = await resolveRepo(cwd);
	if (!currentRepo) {
		throw new Error(`current folder is not a git repository: ${cwd}`);
	}

	const allSessions = await SessionManager.listAll();
	const repoByCwd = new Map<string, RepoIdentity | null>();
	const uniqueSessionCwds = [...new Set(allSessions.map((session) => session.cwd).filter(Boolean) as string[])];

	await Promise.all(
		uniqueSessionCwds.map(async (sessionCwd) => {
			repoByCwd.set(sessionCwd, await resolveRepo(sessionCwd));
		}),
	);

	const sessions = allSessions
		.filter((session) => {
			if (!session.cwd) return false;
			const repo = repoByCwd.get(session.cwd);
			if (!repo) return false;
			return sameRepo(currentRepo, repo);
		})
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	return { repo: currentRepo, sessions };
}

class RepoSessionSelectorComponent implements Component, Focusable {
	private readonly allCandidates: SessionCandidate[];
	private filteredCandidates: SessionCandidate[];
	private readonly searchInput = new Input();
	private selectedIndex = 0;
	private _focused = true;

	constructor(
		private readonly heading: string,
		sessions: SessionInfo[],
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly onSelect: (session: SessionInfo) => void,
		private readonly onCancel: () => void,
	) {
		this.allCandidates = sessions.map((session) => {
			const title = sessionTitle(session);
			const cwd = shortenPath(session.cwd || "(unknown cwd)");
			const age = formatRelativeTime(session.modified);
			const meta = `${age} · ${cwd}`;
			const search = oneLine(`${title} ${cwd} ${session.name ?? ""} ${session.firstMessage ?? ""}`).toLowerCase();
			return { session, title, meta, search };
		});
		this.filteredCandidates = this.allCandidates;
		this.searchInput.focused = true;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", this.heading)));
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredCandidates.length === 0) {
			lines.push(this.theme.fg("muted", "No sessions match your filter."));
			lines.push(this.theme.fg("muted", "Type to search, or press Esc to cancel."));
			return lines;
		}

		const maxVisible = SELECTOR_MAX_VISIBLE;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredCandidates.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredCandidates.length);

		for (let i = startIndex; i < endIndex; i++) {
			const candidate = this.filteredCandidates[i];
			if (!candidate) continue;

			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const metaPlain = candidate.meta;
			const meta = this.theme.fg("muted", metaPlain);
			const availableForTitle = Math.max(8, width - visibleWidth(cursor) - visibleWidth(metaPlain) - 2);
			const title = truncateToWidth(candidate.title, availableForTitle, "…");
			const titleStyled = isSelected ? this.theme.bold(title) : title;
			const leftPlainWidth = visibleWidth(cursor) + visibleWidth(title);
			const spacing = " ".repeat(Math.max(1, width - leftPlainWidth - visibleWidth(metaPlain)));

			lines.push(`${cursor}${titleStyled}${spacing}${meta}`);
		}

		if (startIndex > 0 || endIndex < this.filteredCandidates.length) {
			lines.push(this.theme.fg("muted", `(${this.selectedIndex + 1}/${this.filteredCandidates.length})`));
		}

		lines.push("");
		lines.push(this.theme.fg("muted", truncateToWidth("↑↓ navigate · PgUp/PgDn jump · Enter select · Esc cancel", width, "…")));
		lines.push(this.theme.fg("muted", truncateToWidth("Type to filter by title/path/message", width, "…")));
		return lines;
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredCandidates.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredCandidates.length - 1 : this.selectedIndex - 1;
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredCandidates.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredCandidates.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.pageUp")) {
			if (this.filteredCandidates.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - SELECTOR_MAX_VISIBLE);
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.pageDown")) {
			if (this.filteredCandidates.length === 0) return;
			this.selectedIndex = Math.min(this.filteredCandidates.length - 1, this.selectedIndex + SELECTOR_MAX_VISIBLE);
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredCandidates[this.selectedIndex];
			if (selected) this.onSelect(selected.session);
			return;
		}

		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = oneLine(this.searchInput.getValue()).toLowerCase();
		if (!query) {
			this.filteredCandidates = this.allCandidates;
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredCandidates.length - 1));
			return;
		}

		this.filteredCandidates = this.allCandidates.filter((candidate) => candidate.search.includes(query));
		this.selectedIndex = 0;
	}
}

async function pickSession(
	ctx: ExtensionCommandContext,
	repo: RepoIdentity,
	sessions: SessionInfo[],
): Promise<SessionInfo | undefined> {
	const selectedPath = await ctx.ui.custom<string | undefined>((_tui, theme, keybindings, done) => {
		return new RepoSessionSelectorComponent(
			`Shared sessions (${repo.display})`,
			sessions,
			theme,
			keybindings,
			(session) => done(session.path),
			() => done(undefined),
		);
	});

	if (!selectedPath) return undefined;
	return sessions.find((session) => session.path === selectedPath);
}

function parseMode(args: string): ResumeMode {
	const mode = args.trim().toLowerCase();
	if (!mode) return "pick";
	if (mode === "latest") return "latest";
	throw new Error(`unsupported argument: ${args.trim()} (supported: latest)`);
}

const ARGUMENT_COMPLETIONS = [{ value: "latest", label: "latest" }];

async function runRepoResume(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	let mode = parseMode(args);
	if (!ctx.hasUI && mode === "pick") mode = "latest";

	const { repo, sessions } = await getSharedRepoSessions(pi, ctx.cwd);
	if (sessions.length === 0) {
		ctx.ui.notify(`No sessions found for repo group: ${repo.display}`, "warning");
		return;
	}

	let target: SessionInfo | undefined;
	if (mode === "latest") {
		target = sessions[0];
	} else {
		target = await pickSession(ctx, repo, sessions);
	}

	if (!target) {
		ctx.ui.notify("No session selected.", "warning");
		return;
	}

	const current = ctx.sessionManager.getSessionFile();
	if (current && resolve(current) === resolve(target.path)) {
		ctx.ui.notify("Already on that session.", "info");
		return;
	}

	await ctx.waitForIdle();
	const result = await ctx.switchSession(target.path);
	if (result.cancelled) {
		ctx.ui.notify("Session switch cancelled.", "warning");
		return;
	}

	ctx.ui.notify(`Switched to: ${sessionTitle(target)} (${shortenPath(target.cwd || "(unknown cwd)")})`, "info");
}

export default function registerRepoSharedSessions(pi: ExtensionAPI) {
	pi.registerCommand("repo-resume", {
		description: "Resume sessions from any folder of the same git repo (/repo-resume [latest])",
		getArgumentCompletions: (prefix) => {
			const filtered = ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			try {
				await runRepoResume(pi, args, ctx);
			} catch (error) {
				ctx.ui.notify(`repo-resume failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("repo-sessions", {
		description: "Alias for /repo-resume",
		handler: async (args, ctx) => {
			try {
				await runRepoResume(pi, args, ctx);
			} catch (error) {
				ctx.ui.notify(`repo-sessions failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
