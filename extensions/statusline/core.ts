export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function oneLine(text: string): string {
	const withoutOsc = text.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
	const sgr: string[] = [];
	const protectedText = withoutOsc.replace(/\u001B\[[0-9;]*m/g, (sequence) => {
		const marker = `__PI_UTILS_SGR_${sgr.length}__`;
		sgr.push(sequence);
		return marker;
	});
	const cleaned = protectedText
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/ +/g, " ")
		.trim();
	return cleaned.replace(/__PI_UTILS_SGR_(\d+)__/g, (_match, index: string) => sgr[Number(index)] ?? "");
}

export function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder > 0 ? `${minutes}m${remainder}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const minuteRemainder = minutes % 60;
	return minuteRemainder > 0 ? `${hours}h${minuteRemainder}m` : `${hours}h`;
}

export function collectUsageTotals(entries: readonly unknown[]): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

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

		const input = finiteNumber(usage.input);
		const output = finiteNumber(usage.output);
		const cacheRead = finiteNumber(usage.cacheRead);
		const cacheWrite = finiteNumber(usage.cacheWrite);
		totals.input += input;
		totals.output += output;
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.cost += finiteNumber(usage.cost?.total);

		if (entry.type === "message" && entry.message?.role === "assistant") {
			const promptTokens = input + cacheRead + cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0 ? (100 * cacheRead) / promptTokens : undefined;
		}
	}

	return totals;
}
