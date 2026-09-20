import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { META_PREFIX, hideStreamingMetadata, parseAndStripMetadata, sanitizeLabel } from "../extensions/session-meta/core.ts";

describe("session metadata protocol", () => {
	it("extracts valid start and end records while preserving normal text", () => {
		const input = [
			`${META_PREFIX}{"v":1,"kind":"start","title":"Implement footer","sessionName":"Improve pi-utils"}`,
			"Completed the implementation.",
			`${META_PREFIX}{"v":1,"kind":"end","recap":"Footer implemented and tested"}`,
		].join("\n");
		assert.deepEqual(parseAndStripMetadata(input), {
			start: { kind: "start", title: "Implement footer", sessionName: "Improve pi-utils" },
			end: { kind: "end", recap: "Footer implemented and tested" },
			text: "Completed the implementation.",
		});
	});

	it("hides malformed and partial protocol lines only from streaming display", () => {
		const text = `before\n@@PI_UTILS_META_V1@@{"v":\nafter`;
		assert.equal(hideStreamingMetadata(text), "before\nafter");
		assert.equal(parseAndStripMetadata(text).text, text);
	});

	it("sanitizes control and bidi characters and applies visible limits", () => {
		assert.equal(sanitizeLabel(" a\u0000  b\u202Ec ", 3), "a b");
	});
});
