import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSettings } from "../extensions/settings.ts";

describe("piUtils settings", () => {
	it("preserves defaults, merges trusted-style overrides field by field and rejects malformed input", () => {
		assert.deepEqual(resolveSettings({}), {
			statusline: { showCost: true, showDuration: true, showCache: true, showQuota: true },
			notifications: { settleMs: undefined, userWaitMs: undefined },
		});
		assert.deepEqual(resolveSettings({ statusline: { showCost: false, showQuota: false, compactAtWidth: 150 }, notifications: { settleMs: 3000 } },
			{ statusline: { showQuota: true, showDuration: "no", compactAtWidth: 10 }, notifications: { settleMs: 0, userWaitMs: 2000 } }), {
			statusline: { showCost: false, showDuration: true, showCache: true, showQuota: true, compactAtWidth: 150 },
			notifications: { settleMs: 3000, userWaitMs: 2000 },
		});
	});
});
