import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../tool-activity/core.ts";
import { getUtilsSettings } from "../settings.ts";
import { collectUsageSnapshot, formatDuration, subtractUsage, type UsageSnapshot } from "./core.ts";
import { ENTRY_TYPE, normalizeMetrics, summarizeMetrics, type TurnMetricsData } from "./summary.ts";

const UPDATED_EVENT = "pi-utils/turn-metrics/updated/v1";

export default function turnMetrics(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let startUsage: UsageSnapshot | undefined;
	let firstTokenMs: number | undefined;
	let toolCalls = 0, maxConcurrentTools = 0, retries = 0, compactions = 0;
	let status: TurnMetricsData["status"] = "unknown";
	const active = new Map<string, { name: string; startedAt: number }>();
	let tools: TurnMetricsData["tools"] = [];
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingRetry = false;
	const clearWaitTimer = () => { if (waitTimer) clearTimeout(waitTimer); waitTimer = undefined; };
	const reset = () => {
		startedAt = undefined; startUsage = undefined; firstTokenMs = undefined;
		toolCalls = 0; maxConcurrentTools = 0; retries = 0; compactions = 0;
		status = "unknown"; active.clear(); tools = []; clearWaitTimer(); pendingRetry = false;
	};

	pi.registerEntryRenderer<TurnMetricsData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = normalizeMetrics(entry.data);
		if (!data) return undefined;
		return new Text(theme.fg("dim", `Turn · ${formatDuration(data.durationMs)} · ${data.status} · ${data.toolCalls} tools · ↑${data.usage.input} ↓${data.usage.output}`), 1, 0);
	});
	pi.registerCommand("utils-stats", {
		description: "Read-only settled-run statistics for the current session branch",
		async handler(_args, ctx) {
			if (ctx.hasUI) ctx.ui.notify(summarizeMetrics(ctx.sessionManager.getBranch()), "info");
		},
	});
	pi.on("session_start", reset);
	pi.on("agent_start", (_event, ctx) => {
		if (startedAt !== undefined) { if (pendingRetry) retries++; pendingRetry = false; return; }
		startedAt = Date.now(); startUsage = collectUsageSnapshot(ctx.sessionManager.getEntries());
	});
	pi.on("message_update", (event) => {
		if (startedAt !== undefined && firstTokenMs === undefined && event.message.role === "assistant" &&
			(["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type))) {
			firstTokenMs = Math.max(0, Date.now() - startedAt);
		}
	});
	pi.on("message_end", (event) => {
		if (startedAt === undefined || event.message.role !== "assistant") return;
		const reason = event.message.stopReason;
		pendingRetry = reason === "error";
		status = reason === "stop" || reason === "toolUse" ? "completed" :
			reason === "error" ? "error" : reason === "aborted" ? "aborted" : reason === "length" ? "length" : "unknown";
	});
	pi.on("tool_execution_start", (event) => {
		if (startedAt === undefined || active.has(event.toolCallId)) return;
		toolCalls++;
		active.set(event.toolCallId, { name: sanitizeActivityText(event.toolName, 80), startedAt: Date.now() });
		maxConcurrentTools = Math.max(maxConcurrentTools, active.size);
	});
	pi.on("tool_execution_end", (event) => {
		const tool = active.get(event.toolCallId);
		if (!tool) return;
		if (tools.length < 1000) tools.push({ name: tool.name, durationMs: Math.max(0, Date.now() - tool.startedAt) });
		active.delete(event.toolCallId);
	});
	pi.on("session_compact", (event) => { if (startedAt !== undefined) { compactions++; if (event.willRetry) pendingRetry = true; } });
	pi.on("ui_prompt_start", (_event, ctx) => {
		clearWaitTimer();
		const threshold = getUtilsSettings(ctx).notifications.userWaitMs;
		if (ctx.mode !== "tui" || threshold === undefined) return;
		waitTimer = setTimeout(() => {
			waitTimer = undefined;
			ctx.ui.notify("Waiting for input", "info");
		}, threshold);
		waitTimer.unref?.();
	});
	pi.on("ui_prompt_end", clearWaitTimer);
	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined || startUsage === undefined) return;
		const completedAt = Date.now();
		for (const tool of active.values()) {
			if (tools.length < 1000) tools.push({ name: tool.name, durationMs: Math.max(0, completedAt - tool.startedAt) });
		}
		const data: TurnMetricsData = {
			durationMs: Math.max(0, completedAt - startedAt),
			...(firstTokenMs === undefined ? {} : { firstTokenMs }),
			toolCalls, tools, maxConcurrentTools, retries, compactions, status,
			usage: subtractUsage(collectUsageSnapshot(ctx.sessionManager.getEntries()), startUsage), completedAt,
		};
		pi.appendEntry(ENTRY_TYPE, data);
		pi.events.emit(UPDATED_EVENT, data);
		const threshold = getUtilsSettings(ctx).notifications.settleMs;
		if (ctx.mode === "tui" && threshold !== undefined && data.durationMs > threshold) ctx.ui.notify(`Run settled · ${formatDuration(data.durationMs)}`, "info");
		reset();
	});
	pi.on("session_shutdown", reset);
}
