import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type CacheEntry = {
	fingerprint: string;
	name: string;
	updatedAt: number;
};

type CacheState = {
	version: 1;
	bySessionPath: Record<string, CacheEntry>;
};

type TranscriptData = {
	userMessages: string[];
	assistantMessages: string[];
	toolNames: string[];
};

type RenameOptions = {
	force: boolean;
	dryRun: boolean;
	limit: number;
	quiet: boolean;
};

type RenameRunHooks = {
	setStatus?: (text: string | undefined) => void;
	log?: (line: string) => void;
};

type RenameChange = {
	path: string;
	from: string;
	to: string;
};

type RenameReport = {
	totalSessions: number;
	candidates: number;
	processed: number;
	renamed: number;
	skipped: number;
	errors: Array<{ path: string; error: string }>;
	changes: RenameChange[];
};

const MAX_NAME_LEN = 64;
const MAX_SAMPLE_MESSAGE_LEN = 300;
const MAX_SAMPLES_FROM_START = 10;
const MAX_SAMPLES_FROM_END = 10;
const MAX_ASSISTANT_SAMPLES = 6;
const PI_INFERENCE_TIMEOUT_MS = 45_000;
const AUTO_LIMIT = 250;
const MANUAL_LIMIT = 200;
const MAX_LIMIT = 2_000;
const CACHE_BASENAME = "autoname-sessions.json";
const AUTORUN_ENABLED = /^(1|true|yes)$/i.test(process.env.PI_AUTONAME_SESSIONS_AUTO ?? "");

let activeRunPromise: Promise<RenameReport> | null = null;
let hasAutoRunThisProcess = false;

function getCachePath(): string {
	const home = process.env.HOME ?? process.cwd();
	return join(home, ".pi", "agent", "cache", CACHE_BASENAME);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLen: number): string {
	const t = oneLine(text);
	if (t.length <= maxLen) return t;
	return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function normalizeName(raw: string): string {
	let name = oneLine(raw)
		.toLowerCase()
		.replace(/^name\s*:\s*/i, "")
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/[.!?,;:]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!name) return "";

	const words = name.split(" ").filter(Boolean);
	if (words.length > 10) name = words.slice(0, 10).join(" ");

	if (name.length > MAX_NAME_LEN) {
		name = name.slice(0, MAX_NAME_LEN);
		const lastSpace = name.lastIndexOf(" ");
		if (lastSpace > 15) name = name.slice(0, lastSpace);
	}

	name = name.replace(/^[-–—\s]+|[-–—\s]+$/g, "");
	return name;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return oneLine(content);
	if (!Array.isArray(content)) return "";

	const chunks: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") chunks.push(b.text);
		if (b.type === "toolCall") {
			const toolName = typeof b.name === "string" ? b.name : "tool";
			chunks.push(`[tool:${toolName}]`);
		}
	}

	return oneLine(chunks.join(" "));
}

function extractTranscript(entries: SessionEntry[]): TranscriptData {
	const userMessages: string[] = [];
	const assistantMessages: string[] = [];
	const tools = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const msg = entry.message as Record<string, unknown>;
		const role = msg.role;

		if (role === "user") {
			const text = textFromContent(msg.content);
			if (text) userMessages.push(text);
			continue;
		}

		if (role === "assistant") {
			const text = textFromContent(msg.content);
			if (text) assistantMessages.push(text);
			continue;
		}

		if (role === "toolResult") {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
			if (toolName) tools.add(toolName);
			const text = textFromContent(msg.content);
			if (text) assistantMessages.push(`[tool-result:${toolName ?? "unknown"}] ${text}`);
		}
	}

	return {
		userMessages,
		assistantMessages,
		toolNames: [...tools].sort(),
	};
}

function fallbackNameFromTranscript(data: TranscriptData): string {
	const first = data.userMessages.find((m) => !!m.trim());
	if (!first) return "session triage";

	let t = first.toLowerCase();
	t = t.replace(/^please\s+/, "");
	t = t.replace(/^can you\s+/, "");
	t = t.replace(/^could you\s+/, "");
	t = t.replace(/^i want (you )?to\s+/, "");
	t = t.replace(/^help me\s+/, "");
	t = t.replace(/^write me\s+/, "write ");
	t = t.replace(/^let'?s\s+/, "");
	t = oneLine(t);

	t = t.split(/[.!?\n]/)[0] ?? t;

	const words = t.split(" ").filter(Boolean).slice(0, 10);
	return normalizeName(words.join(" ")) || "session triage";
}

function extractNameFromModelOutput(output: string): string {
	const text = output.trim();
	if (!text) return "";

	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			if (typeof parsed.name === "string") return normalizeName(parsed.name);
		} catch {
			// ignore invalid JSON and continue to fallback
		}
	}

	const firstLine = text.split("\n").find((line) => line.trim());
	return normalizeName(firstLine ?? "");
}

function buildPrompt(session: SessionInfo, transcript: TranscriptData): string {
	const startUser = transcript.userMessages
		.slice(0, MAX_SAMPLES_FROM_START)
		.map((m, i) => `${i + 1}. ${clipText(m, MAX_SAMPLE_MESSAGE_LEN)}`);
	const endUser = transcript.userMessages
		.slice(-MAX_SAMPLES_FROM_END)
		.map((m, i) => `${i + 1}. ${clipText(m, MAX_SAMPLE_MESSAGE_LEN)}`);
	const assistant = transcript.assistantMessages
		.slice(-MAX_ASSISTANT_SAMPLES)
		.map((m, i) => `${i + 1}. ${clipText(m, MAX_SAMPLE_MESSAGE_LEN)}`);

	const tools = transcript.toolNames.length > 0 ? transcript.toolNames.join(", ") : "none";
	const existingName = (session.name ?? "").trim() || "(none)";

	return [
		"You name coding sessions.",
		"Infer the single main purpose of this session from the transcript-derived data.",
		"Return ONLY strict JSON on one line: {\"name\":\"...\"}",
		"Rules for name:",
		"- 3 to 10 words",
		"- lowercase",
		"- concise and specific",
		"- no trailing punctuation",
		"- describe the main objective, not a status update",
		"",
		`session cwd: ${session.cwd}`,
		`existing name: ${existingName}`,
		`message count: ${session.messageCount}`,
		`tools used: ${tools}`,
		"",
		"first user messages:",
		...(startUser.length ? startUser : ["(none)"]),
		"",
		"last user messages:",
		...(endUser.length ? endUser : ["(none)"]),
		"",
		"recent assistant messages:",
		...(assistant.length ? assistant : ["(none)"]),
		"",
		"Output JSON only.",
	].join("\n");
}

function fingerprintOf(session: SessionInfo): string {
	return `${session.modified.getTime()}:${session.messageCount}`;
}

async function loadCache(): Promise<CacheState> {
	const path = getCachePath();
	if (!existsSync(path)) return { version: 1, bySessionPath: {} };

	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<CacheState>;
		if (parsed.version !== 1 || !parsed.bySessionPath || typeof parsed.bySessionPath !== "object") {
			return { version: 1, bySessionPath: {} };
		}
		return { version: 1, bySessionPath: parsed.bySessionPath as Record<string, CacheEntry> };
	} catch {
		return { version: 1, bySessionPath: {} };
	}
}

async function saveCache(cache: CacheState): Promise<void> {
	const path = getCachePath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
}

function shouldProcessSession(session: SessionInfo, cache: CacheState, opts: RenameOptions): boolean {
	if (opts.force) return true;

	const cached = cache.bySessionPath[session.path];
	const currentFingerprint = fingerprintOf(session);

	if (!session.name || !session.name.trim()) {
		if (!cached) return true;
		return cached.fingerprint !== currentFingerprint;
	}

	if (!cached) {
		// Existing non-empty name never set by this extension: keep it.
		return false;
	}

	if (session.name.trim() !== cached.name) {
		// User changed the name manually: respect user override.
		return false;
	}

	return cached.fingerprint !== currentFingerprint;
}

async function inferNameWithPi(pi: ExtensionAPI, session: SessionInfo, transcript: TranscriptData): Promise<string> {
	const prompt = buildPrompt(session, transcript);
	const result = await pi.exec(
		"pi",
		["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "-p", prompt],
		{ timeout: PI_INFERENCE_TIMEOUT_MS },
	);

	if (result.code !== 0) throw new Error(result.stderr.trim() || `pi exited with code ${result.code}`);

	const candidate = extractNameFromModelOutput(result.stdout);
	if (!candidate) throw new Error("model returned empty name");
	return candidate;
}

async function renameSessions(pi: ExtensionAPI, opts: RenameOptions, hooks: RenameRunHooks = {}): Promise<RenameReport> {
	if (activeRunPromise) {
		try {
			await activeRunPromise;
		} catch {
			// Do not block a new run because the previous one failed.
		}
	}

	const log = hooks.log;
	const setStatus = hooks.setStatus;

	const runPromise = (async (): Promise<RenameReport> => {
		setStatus?.("autoname-sessions: listing sessions...");
		const allSessions = await SessionManager.listAll();
		log?.(`listed ${allSessions.length} total sessions`);

		setStatus?.("autoname-sessions: loading cache...");
		const cache = await loadCache();

		setStatus?.("autoname-sessions: selecting candidates...");
		const candidates = allSessions
			.filter((session) => shouldProcessSession(session, cache, opts))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, Math.max(1, opts.limit));

		log?.(
			`selected ${candidates.length} candidate sessions (limit=${opts.limit}, force=${opts.force}, dryRun=${opts.dryRun})`,
		);

		const report: RenameReport = {
			totalSessions: allSessions.length,
			candidates: candidates.length,
			processed: 0,
			renamed: 0,
			skipped: 0,
			errors: [],
			changes: [],
		};

		for (const session of candidates) {
			report.processed += 1;
			const file = basename(session.path);
			setStatus?.(`autoname-sessions: ${report.processed}/${report.candidates} ${file}`);

			try {
				const manager = SessionManager.open(session.path);
				const entries = manager.getEntries();
				const transcript = extractTranscript(entries);

				if (transcript.userMessages.length === 0) {
					report.skipped += 1;
					log?.(`skip ${file}: no user messages`);
					continue;
				}

				let inferredName: string;
				let usedFallback = false;
				try {
					inferredName = await inferNameWithPi(pi, session, transcript);
				} catch (error) {
					usedFallback = true;
					log?.(
						`pi inference failed for ${file}: ${error instanceof Error ? error.message : String(error)} (using fallback)`,
					);
					inferredName = fallbackNameFromTranscript(transcript);
				}

				const normalized = normalizeName(inferredName);
				if (!normalized) {
					report.skipped += 1;
					log?.(`skip ${file}: inferred empty name${usedFallback ? " (fallback)" : ""}`);
					continue;
				}

				const currentName = (manager.getSessionName() ?? "").trim();
				if (!opts.force && currentName && currentName === normalized) {
					cache.bySessionPath[session.path] = {
						fingerprint: fingerprintOf(session),
						name: normalized,
						updatedAt: Date.now(),
					};
					report.skipped += 1;
					log?.(`skip ${file}: already named "${normalized}"`);
					continue;
				}

				report.changes.push({ path: session.path, from: currentName, to: normalized });
				if (!opts.dryRun) manager.appendSessionInfo(normalized);

				cache.bySessionPath[session.path] = {
					fingerprint: fingerprintOf(session),
					name: normalized,
					updatedAt: Date.now(),
				};
				report.renamed += 1;

				const from = currentName || "(unnamed)";
				log?.(
					`${opts.dryRun ? "plan" : "rename"} ${file}: ${from} -> ${normalized}${usedFallback ? " (fallback)" : ""}`,
				);
			} catch (error) {
				report.errors.push({
					path: session.path,
					error: error instanceof Error ? error.message : String(error),
				});
				log?.(`error ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		setStatus?.(reportLine(report, opts.dryRun));
		log?.(reportLine(report, opts.dryRun));

		if (!opts.dryRun) await saveCache(cache);
		return report;
	})();

	activeRunPromise = runPromise;
	try {
		return await runPromise;
	} finally {
		if (activeRunPromise === runPromise) activeRunPromise = null;
	}
}

function parseOptions(args: string, defaults: RenameOptions): RenameOptions {
	const tokens = args
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	const out: RenameOptions = { ...defaults };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const lower = token.toLowerCase();
		const next = tokens[i + 1]?.toLowerCase();

		if (lower === "--force" || lower === "force") {
			out.force = true;
			continue;
		}

		if (lower === "--dry-run" || lower === "dry-run" || lower === "dryrun") {
			out.dryRun = true;
			continue;
		}

		if (lower === "dry" && next === "run") {
			out.dryRun = true;
			i += 1;
			continue;
		}

		if (lower === "--quiet" || lower === "quiet") {
			out.quiet = true;
			continue;
		}

		if (lower === "--limit" && tokens[i + 1]) {
			const parsed = Number.parseInt(tokens[i + 1]!, 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				out.limit = parsed;
				i += 1;
			}
			continue;
		}

		if (lower.startsWith("--limit=")) {
			const parsed = Number.parseInt(lower.slice("--limit=".length), 10);
			if (Number.isFinite(parsed) && parsed > 0) out.limit = parsed;
		}
	}

	out.limit = Math.max(1, Math.min(out.limit, MAX_LIMIT));
	return out;
}

function reportLine(report: RenameReport, dryRun = false): string {
	let line = `autoname: processed ${report.processed}/${report.candidates} candidate sessions`;
	line += dryRun
		? `, would rename ${report.renamed}, skipped ${report.skipped}`
		: `, renamed ${report.renamed}, skipped ${report.skipped}`;
	if (report.errors.length > 0) line += `, errors ${report.errors.length}`;
	if (report.candidates === 0) line += " (tip: use --force to preview all sessions)";
	return line;
}

function formatRenamePreview(report: RenameReport, dryRun: boolean, maxLines = 10): string | null {
	if (report.changes.length === 0) return null;

	const title = dryRun ? "planned renames:" : "applied renames:";
	const rows = report.changes.slice(0, Math.max(1, maxLines)).map((change, i) => {
		const from = change.from || "(unnamed)";
		const file = basename(change.path);
		return `${i + 1}. ${from} -> ${change.to} (${file})`;
	});

	const remaining = report.changes.length - rows.length;
	if (remaining > 0) rows.push(`… and ${remaining} more`);

	return [title, ...rows].join("\n");
}

async function runAuto(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (hasAutoRunThisProcess) return;
	hasAutoRunThisProcess = true;

	const opts: RenameOptions = {
		force: false,
		dryRun: false,
		limit: AUTO_LIMIT,
		quiet: true,
	};

	try {
		const report = await renameSessions(pi, opts);
		if (report.renamed > 0 || report.errors.length > 0) {
			ctx.ui.notify(reportLine(report), report.errors.length > 0 ? "warning" : "info");
		}
	} catch (error) {
		ctx.ui.notify(`session autonamer failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function registerAutonameSessions(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!AUTORUN_ENABLED) return;
		if (!ctx.hasUI) return;
		void runAuto(pi, ctx);
	});

	const command = {
		description: "Auto-name sessions by inferred purpose from transcript context",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "--force", label: "--force" },
				{ value: "--dry-run", label: "--dry-run" },
				{ value: "dry run", label: "dry run" },
				{ value: "--limit 50", label: "--limit 50" },
				{ value: "--quiet", label: "--quiet" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext & { waitForIdle: () => Promise<void> }) => {
			const opts = parseOptions(args, {
				force: false,
				dryRun: false,
				limit: MANUAL_LIMIT,
				quiet: false,
			});

			const widgetId = "autoname-sessions";
			const maxLogLines = 14;
			const logLines: string[] = [];

			const pushLog = (line: string) => {
				if (opts.quiet) return;
				if (!ctx.hasUI) return;
				logLines.push(line);
				while (logLines.length > maxLogLines) logLines.shift();
				ctx.ui.setWidget(widgetId, logLines);
			};

			const hooks: RenameRunHooks = {
				setStatus: (text) => {
					if (opts.quiet) return;
					if (!ctx.hasUI) return;
					ctx.ui.setStatus(widgetId, text);
				},
				log: (line) => pushLog(line),
			};

			try {
				// Always emit a visible message so the user knows the command started.
				if (!opts.quiet) {
					pi.sendMessage({
						customType: "autoname-sessions",
						content: `autoname-sessions: starting${args.trim() ? ` (args: ${args.trim()})` : ""}`,
						display: true,
					});
				}

				pushLog("waiting for agent to be idle...");
				await ctx.waitForIdle();
				pushLog("agent idle; running...");

				const report = await renameSessions(pi, opts, hooks);

				if (!opts.quiet) {
					const summary = reportLine(report, opts.dryRun);
					ctx.ui.notify(summary, report.errors.length > 0 ? "warning" : "info");

					const preview = formatRenamePreview(report, opts.dryRun, 20);
					const messageLines: string[] = [summary];
					if (preview) messageLines.push("", preview);

					if (report.errors.length > 0) {
						const first = report.errors[0]!;
						messageLines.push("", `first error: ${first.error}`);
						ctx.ui.notify(`first error: ${first.error}`, "warning");
					}

					pi.sendMessage({
						customType: "autoname-sessions",
						content: messageLines.join("\n"),
						display: true,
					});
				}
			} catch (error) {
				const msg = `autoname-sessions failed: ${error instanceof Error ? error.message : String(error)}`;
				if (!opts.quiet) {
					pi.sendMessage({ customType: "autoname-sessions", content: msg, display: true });
				}
				ctx.ui.notify(msg, "error");
			} finally {
				if (!opts.quiet && ctx.hasUI) {
					ctx.ui.setStatus(widgetId, undefined);
					ctx.ui.setWidget(widgetId, undefined);
				}
			}
		},
	};

	pi.registerCommand("autoname-sessions", command);
	// Common typo alias
	pi.registerCommand("autorname-sessions", {
		...command,
		description: "Alias for /autoname-sessions (common typo)",
	});
}
