import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { basename, resolve } from "node:path";

type RepoIdentity = {
	key: string;
	display: string;
	remote?: string;
	topLevel?: string;
};

type ResumeMode = "pick" | "latest";

const GIT_TIMEOUT_MS = 4_000;
const MAX_TITLE_LEN = 70;

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

function optionLabel(index: number, session: SessionInfo): string {
	const title = sessionTitle(session);
	const age = formatRelativeTime(session.modified);
	const cwd = shortenPath(session.cwd || "(unknown cwd)");
	return `[${index + 1}] ${title} · ${age} · ${cwd}`;
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
		const options = sessions.map((session, index) => ({
			label: optionLabel(index, session),
			session,
		}));
		const selected = await ctx.ui.select(`Shared sessions (${repo.display})`, options.map((option) => option.label));
		if (!selected) return;
		target = options.find((option) => option.label === selected)?.session;
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
