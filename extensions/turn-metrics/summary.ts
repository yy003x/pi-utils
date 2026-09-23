import { sanitizeActivityText } from "../tool-activity/core.ts";
import type { UsageSnapshot } from "./core.ts";

export const ENTRY_TYPE = "pi-utils:turn-metrics:summary";
export interface TurnMetricsData {
	durationMs: number;
	firstTokenMs?: number;
	toolCalls: number;
	tools: { name: string; durationMs: number }[];
	maxConcurrentTools: number;
	retries: number;
	compactions: number;
	status: "completed" | "error" | "aborted" | "length" | "unknown";
	usage: UsageSnapshot;
	completedAt: number;
}
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function validMetrics(value: unknown): value is TurnMetricsData {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!["completed", "error", "aborted", "length", "unknown"].includes(String(v.status))) return false;
	if (![v.durationMs, v.toolCalls, v.maxConcurrentTools, v.retries, v.compactions, v.completedAt].every(number)) return false;
	if (v.firstTokenMs !== undefined && !number(v.firstTokenMs)) return false;
	if (!Array.isArray(v.tools) || v.tools.length > 1000 || !v.tools.every((tool: unknown) => {
		if (!tool || typeof tool !== "object") return false;
		const item = tool as Record<string, unknown>;
		return typeof item.name === "string" && item.name.length <= 80 &&
			sanitizeActivityText(item.name) === item.name && number(item.durationMs);
	})) return false;
	const usage = v.usage;
	return !!usage && typeof usage === "object" && ["input", "output", "cacheRead", "cacheWrite", "cost"]
		.every((key) => number((usage as Record<string, unknown>)[key]));
}
export function normalizeMetrics(value: unknown): TurnMetricsData | undefined {
	if (validMetrics(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const old = value as Record<string, unknown>;
	// A malformed new entry is not a legacy record. Only the original
	// four-field shape may be normalized for pre-upgrade sessions.
	if (Object.keys(old).some((key) => !["durationMs", "toolCalls", "usage", "completedAt"].includes(key))) return undefined;
	if (![old.durationMs, old.toolCalls, old.completedAt].every(number) || !old.usage || typeof old.usage !== "object") return undefined;
	const usage = old.usage as Record<string, unknown>;
	if (!["input", "output", "cacheRead", "cacheWrite", "cost"].every((key) => number(usage[key]))) return undefined;
	return {
		durationMs: old.durationMs as number, toolCalls: old.toolCalls as number, completedAt: old.completedAt as number,
		tools: [], maxConcurrentTools: 0, retries: 0, compactions: 0, status: "unknown",
		usage: usage as unknown as UsageSnapshot,
	};
}
export function summarizeMetrics(entries: readonly unknown[]): string {
	const rows = entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		const data = record.type === "custom" && record.customType === ENTRY_TYPE ? normalizeMetrics(record.data) : undefined;
		return data ? [data] : [];
	});
	const total = (key: "durationMs" | "toolCalls" | "retries" | "compactions") => rows.reduce((sum, row) => sum + row[key], 0);
	const first = rows.filter((row) => row.firstTokenMs !== undefined);
	const toolTimes = new Map<string, { count: number; ms: number }>();
	for (const row of rows) for (const tool of row.tools) {
		const current = toolTimes.get(tool.name) ?? { count: 0, ms: 0 };
		current.count++; current.ms += tool.durationMs;
		toolTimes.set(tool.name, current);
	}
	const slowest = [...toolTimes.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
		.map(([name, value]) => `${name} ${Math.round(value.ms)}ms/${value.count}`);
	return `Current branch · ${rows.length} settled run(s) · ${Math.round(total("durationMs") / 1000)}s · ${total("toolCalls")} tools · ${total("retries")} retries · ${total("compactions")} compactions · first token avg ${first.length ? `${Math.round(first.reduce((sum, row) => sum + row.firstTokenMs!, 0) / first.length)}ms` : "n/a"} · ${rows.filter((row) => row.status !== "completed" && row.status !== "unknown").length} non-completed${slowest.length ? ` · tool time ${slowest.join(", ")}` : ""}`;
}
