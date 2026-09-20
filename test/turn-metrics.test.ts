import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectUsageSnapshot, formatDuration, subtractUsage } from "../extensions/turn-metrics/core.ts";

describe("turn metrics core", () => {
	it("collects and subtracts usage snapshots", () => {
		const usage = { input: 10, output: 4, cacheRead: 20, cacheWrite: 2, cost: { total: 0.25 } };
		const before = collectUsageSnapshot([{ type: "message", message: { role: "assistant", usage } }]);
		const after = collectUsageSnapshot([
			{ type: "message", message: { role: "assistant", usage } },
			{ type: "branch_summary", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } },
		]);
		assert.deepEqual(subtractUsage(after, before), {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.04999999999999999,
		});
	});

	it("formats human-readable durations", () => {
		assert.equal(formatDuration(2_000), "2s");
		assert.equal(formatDuration(125_000), "2m 5s");
		assert.equal(formatDuration(3_660_000), "1h 1m");
	});
});
