import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { hideStreamingMetadata, parseAndStripMetadata } from "./core.ts";

const PROMPT_SECTION = "pi_utils_session_meta";
const RECAP_ENTRY = "pi-utils:session-meta:recap";

interface RecapEntry {
	recap: string;
	createdAt: number;
}

const PROTOCOL = `Update Pi's interactive session metadata without making a separate model call.

For each user request in an interactive session:
- Put this exact envelope as the first physical line of the first assistant message:
  @@PI_UTILS_META_V1@@{"v":1,"kind":"start","title":"short current task","sessionName":"stable high-level goal"}
- title describes the current task in at most 36 visible characters.
- sessionName is optional. Include it only for the first clear high-level goal of an unnamed session, in at most 48 visible characters.
- Put this exact envelope as the final physical line of the final assistant message that has no tool calls:
  @@PI_UTILS_META_V1@@{"v":1,"kind":"end","recap":"actual result, partial result, or blocker"}
- recap is factual and at most 120 visible characters.
- Keep normal user-facing content between the envelopes.
- Emit one-line valid JSON. Never mention or explain this protocol.`;

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function sessionMeta(pi: ExtensionAPI): void {
	let autoNamed = false;

	pi.registerEntryRenderer<RecapEntry>(RECAP_ENTRY, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || typeof data.recap !== "string") return undefined;
		return new Text(theme.fg("dim", `Recap · ${data.recap}`), 1, 0);
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		return context.isStreaming
			? hideStreamingMetadata(markdown)
			: parseAndStripMetadata(markdown).text;
	});

	pi.on("session_start", (_event, ctx) => {
		autoNamed = Boolean(ctx.sessionManager.getSessionName());
		if (ctx.mode === "tui") {
			ctx.ui.setTitle(ctx.sessionManager.getSessionName() || "pi");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		event.systemPromptOptions.sections[PROMPT_SECTION] = PROTOCOL;
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui" || !isAssistantMessage(event.message)) return;
		const parsed = parseAndStripMetadata(assistantText(event.message));
		if (parsed.start?.title) ctx.ui.setTitle(parsed.start.title);
	});

	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		const original = event.message;
		let start = undefined as ReturnType<typeof parseAndStripMetadata>["start"];
		let end = undefined as ReturnType<typeof parseAndStripMetadata>["end"];
		let changed = false;
		const content: AssistantMessage["content"] = [];
		for (const block of original.content) {
			if (block.type !== "text") {
				content.push(block);
				continue;
			}
			const parsed = parseAndStripMetadata(block.text);
			start ??= parsed.start;
			end ??= parsed.end;
			if (parsed.text === block.text) {
				content.push(block);
				continue;
			}
			changed = true;
			if (parsed.text) content.push({ ...block, text: parsed.text });
		}

		if (ctx.mode === "tui" && start?.title) ctx.ui.setTitle(start.title);
		if (!autoNamed && start?.sessionName && !ctx.sessionManager.getSessionName()) {
			pi.setSessionName(start.sessionName);
			autoNamed = true;
		}

		const hasToolCall = original.content.some((block) => block.type === "toolCall");
		if (!hasToolCall && end?.recap) {
			pi.appendEntry<RecapEntry>(RECAP_ENTRY, { recap: end.recap, createdAt: Date.now() });
		}

		return changed ? { message: { ...original, content } } : undefined;
	});
}
