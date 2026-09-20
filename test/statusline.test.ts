import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectUsageTotals, formatDuration, formatTokens, oneLine } from "../extensions/statusline/core.ts";

describe("statusline core", () => {
	it("formats compact token and duration values", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1_250), "1.3k");
		assert.equal(formatTokens(1_250_000), "1.3M");
		assert.equal(formatDuration(61_000), "1m1s");
	});

	it("normalizes status text, strips terminal controls, and preserves SGR colors", () => {
		assert.equal(oneLine("  a\n\tb\u0007   c\u202E  "), "a b c");
		assert.equal(oneLine("\u001b[31mred\u001b[0m\u001b]0;bad\u0007"), "\u001b[31mred\u001b[0m");
	});

	it("collects all persisted usage without counting unrelated entries", () => {
		const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
			input,
			output,
			cacheRead,
			cacheWrite,
			cost: { total: cost },
		});
		const totals = collectUsageTotals([
			{ type: "message", message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) } },
			{ type: "message", message: { role: "toolResult", usage: usage(1, 0, 0, 0, 0.01) } },
			{ type: "compaction", usage: usage(3, 1, 2, 0, 0.02) },
			{ type: "custom", data: {} },
		]);
		assert.deepEqual(
			{ ...totals, latestCacheHitRate: undefined },
			{
				input: 14,
				output: 3,
				cacheRead: 32,
				cacheWrite: 5,
				cost: 0.13,
				latestCacheHitRate: undefined,
			},
		);
		assert.ok(Math.abs((totals.latestCacheHitRate ?? 0) - (30 / 45) * 100) < 1e-9);
	});
});
