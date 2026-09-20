import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolActivity, type ToolActivityItem } from "./core.ts";

const WIDGET_KEY = "pi-utils.tool-activity";

export default function toolActivity(pi: ExtensionAPI): void {
	let running = false;
	let waitingTitle: string | undefined;
	const tools = new Map<string, ToolActivityItem>();

	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const lines = renderToolActivity({ running, waitingTitle, tools: [...tools.values()] });
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
	};

	pi.on("session_start", (_event, ctx) => {
		running = false;
		waitingTitle = undefined;
		tools.clear();
		render(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		running = true;
		waitingTitle = undefined;
		render(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName });
		render(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		tools.delete(event.toolCallId);
		render(ctx);
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		waitingTitle = event.title?.trim() || event.kind;
		render(ctx);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		waitingTitle = undefined;
		render(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		running = false;
		waitingTitle = undefined;
		tools.clear();
		render(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		running = false;
		waitingTitle = undefined;
		tools.clear();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
