interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function collectUsageSnapshot(entries: readonly unknown[]): UsageSnapshot {
	const total: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const rawEntry of entries) {
		if (!rawEntry || typeof rawEntry !== "object") continue;
		const entry = rawEntry as {
			type?: string;
			message?: { role?: string; usage?: UsageLike };
			usage?: UsageLike;
		};
		let usage: UsageLike | undefined;
		if (
			entry.type === "message" &&
			(entry.message?.role === "assistant" || entry.message?.role === "toolResult")
		) {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;
		total.input += finiteNumber(usage.input);
		total.output += finiteNumber(usage.output);
		total.cacheRead += finiteNumber(usage.cacheRead);
		total.cacheWrite += finiteNumber(usage.cacheWrite);
		total.cost += finiteNumber(usage.cost?.total);
	}
	return total;
}

export function subtractUsage(after: UsageSnapshot, before: UsageSnapshot): UsageSnapshot {
	return {
		input: Math.max(0, after.input - before.input),
		output: Math.max(0, after.output - before.output),
		cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
		cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
		cost: Math.max(0, after.cost - before.cost),
	};
}

export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const minuteRemainder = minutes % 60;
	return minuteRemainder > 0 ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}
