import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolActivity, sanitizeActivityText, type ToolActivityItem, type ToolActivityView } from "./core.ts";

const WIDGET_KEY = "pi-utils.tool-activity";
export default function toolActivity(pi: ExtensionAPI): void {
	let running = false, completed = 0;
	let phase: ToolActivityView["phase"] = "agent";
	let waitingTitle: string | undefined, runStartedAt = 0, waitStartedAt = 0;
	let ticker: ReturnType<typeof setInterval> | undefined;
	const tools = new Map<string, ToolActivityItem>();
	const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = undefined; };
	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const longestToolStart = [...tools.values()].reduce<number | undefined>(
			(oldest, tool) => tool.startedAt === undefined ? oldest : Math.min(oldest ?? tool.startedAt, tool.startedAt), undefined);
		const lines = renderToolActivity({ running, waitingTitle, tools: [...tools.values()], phase,
			durationMs: waitingTitle && waitStartedAt ? Date.now() - waitStartedAt : longestToolStart !== undefined ? Date.now() - longestToolStart : running && runStartedAt ? Date.now() - runStartedAt : undefined, completed });
		ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined, { placement: "aboveEditor" });
		if ((running || waitingTitle) && !ticker) { ticker = setInterval(() => render(ctx), 1000); ticker.unref(); }
		if (!running && !waitingTitle) stopTicker();
	};
	const reset = (ctx: ExtensionContext) => {
		running = false; completed = 0; waitingTitle = undefined;
		phase = "agent"; runStartedAt = 0; waitStartedAt = 0; tools.clear(); stopTicker(); render(ctx);
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("agent_start", (_event, ctx) => { if (!running) runStartedAt = Date.now(); running = true; phase = "agent"; waitingTitle = undefined; render(ctx); });
	pi.on("before_provider_request", (_event, ctx) => { if (running && !tools.size && !waitingTitle) { phase = "provider"; render(ctx); } });
	pi.on("message_update", (event, ctx) => {
		if (running && phase === "provider" && ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)) {
			phase = "agent"; render(ctx);
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		tools.set(event.toolCallId, { id: event.toolCallId, name: sanitizeActivityText(event.toolName, 80), startedAt: Date.now() });
		phase = "tool"; render(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const tool = tools.get(event.toolCallId);
		if (tool) completed++;
		tools.delete(event.toolCallId);
		if (!tools.size) { phase = "agent"; }
		render(ctx);
	});
	pi.on("ui_prompt_start", (event, ctx) => { waitingTitle = event.kind; waitStartedAt = Date.now(); phase = "user wait"; render(ctx); });
	pi.on("ui_prompt_end", (_event, ctx) => { waitingTitle = undefined; waitStartedAt = 0; phase = tools.size ? "tool" : "agent"; render(ctx); });
	pi.on("agent_settled", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}
