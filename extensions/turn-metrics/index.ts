import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { collectUsageSnapshot, formatDuration, subtractUsage, type UsageSnapshot } from "./core.ts";

const ENTRY_TYPE = "pi-utils:turn-metrics:summary";
const UPDATED_EVENT = "pi-utils/turn-metrics/updated/v1";

interface TurnMetricsData {
	durationMs: number;
	toolCalls: number;
	usage: UsageSnapshot;
	completedAt: number;
}

export default function turnMetrics(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let startUsage: UsageSnapshot | undefined;
	let toolCalls = 0;

	pi.registerEntryRenderer<TurnMetricsData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || typeof data.durationMs !== "number") return undefined;
		const usage = data.usage;
		const tokens = usage && typeof usage.input === "number" && typeof usage.output === "number"
			? ` · ↑${usage.input} ↓${usage.output}`
			: "";
		const tools = data.toolCalls > 0 ? ` · ${data.toolCalls} tool${data.toolCalls === 1 ? "" : "s"}` : "";
		return new Text(theme.fg("dim", `Turn · ${formatDuration(data.durationMs)}${tools}${tokens}`), 1, 0);
	});

	pi.on("session_start", () => {
		startedAt = undefined;
		startUsage = undefined;
		toolCalls = 0;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (startedAt !== undefined) return;
		startedAt = Date.now();
		startUsage = collectUsageSnapshot(ctx.sessionManager.getEntries());
		toolCalls = 0;
	});

	pi.on("tool_execution_start", () => {
		if (startedAt !== undefined) toolCalls++;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined || startUsage === undefined) return;
		const completedAt = Date.now();
		const data: TurnMetricsData = {
			durationMs: Math.max(0, completedAt - startedAt),
			toolCalls,
			usage: subtractUsage(collectUsageSnapshot(ctx.sessionManager.getEntries()), startUsage),
			completedAt,
		};
		pi.appendEntry<TurnMetricsData>(ENTRY_TYPE, data);
		pi.events.emit(UPDATED_EVENT, data);
		startedAt = undefined;
		startUsage = undefined;
		toolCalls = 0;
	});

	pi.on("session_shutdown", () => {
		startedAt = undefined;
		startUsage = undefined;
		toolCalls = 0;
	});
}
