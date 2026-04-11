import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";

const SHORTCUT = "alt+o";
const COMMAND = "copy-last-response";

type CopyResult =
	| { ok: true; markdown: string }
	| { ok: false; message: string; level?: "info" | "warning" | "error" };

function extractAssistantMarkdown(ctx: ExtensionContext): CopyResult {
	if (!ctx.isIdle()) {
		return {
			ok: false,
			message: "Wait for the response to finish before copying.",
			level: "warning",
		};
	}

	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;

		const message = entry.message;
		if (message.role !== "assistant") continue;

		if (message.stopReason !== "stop") {
			return {
				ok: false,
				message: `Last assistant response is incomplete (${message.stopReason}).`,
				level: "warning",
			};
		}

		const markdown = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n\n")
			.trim();

		if (!markdown) {
			return {
				ok: false,
				message: "Last assistant response has no markdown text to copy.",
				level: "warning",
			};
		}

		return { ok: true, markdown };
	}

	return {
		ok: false,
		message: "No assistant response found.",
		level: "info",
	};
}

async function copyLastResponse(ctx: ExtensionContext): Promise<void> {
	const result = extractAssistantMarkdown(ctx);
	if (!result.ok) {
		ctx.ui.notify(result.message, result.level ?? "info");
		return;
	}

	try {
		await copyToClipboard(result.markdown);
		ctx.ui.notify("Copied last response as markdown.", "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to copy response to clipboard: ${message}`, "error");
	}
}

export default function registerCopyLastResponse(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "Copy the last completed assistant response to the clipboard as markdown",
		handler: async (_args, ctx) => {
			await copyLastResponse(ctx);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Copy the last completed assistant response as markdown",
		handler: async (ctx) => {
			await copyLastResponse(ctx);
		},
	});
}
