import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeToolName, renderToolActivity, sanitizeActivityText } from "../extensions/tool-activity/core.ts";

describe("tool activity core", () => {
	it("renders idle, running, waiting, and concurrent tool states", () => {
		assert.deepEqual(renderToolActivity({ running: false, tools: [] }), []);
		assert.deepEqual(renderToolActivity({ running: true, tools: [] }), ["Agent working"]);
		assert.deepEqual(renderToolActivity({ running: true, waitingTitle: "Choose model", tools: [] }), [
			"User wait · Choose model",
		]);
		assert.deepEqual(
			renderToolActivity({
				running: true,
				tools: [
					{ id: "1", name: "read" },
					{ id: "2", name: "mcp__server__search" },
				],
			}),
			["Tools (2 concurrent) · read · mcp:server/search"],
		);
	});

	it("normalizes namespaced tool names and strips terminal controls", () => {
		assert.equal(normalizeToolName("mcp__foo__bar"), "mcp:foo/bar");
		assert.equal(sanitizeActivityText("pick\u001b[31m model\u202E"), "pick model");
	});
});
