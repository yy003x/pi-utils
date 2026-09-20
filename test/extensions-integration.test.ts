import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionMeta from "../extensions/session-meta/index.ts";
import statusline from "../extensions/statusline/index.ts";
import toolActivity from "../extensions/tool-activity/index.ts";
import turnMetrics from "../extensions/turn-metrics/index.ts";

type Handler = (event: any, ctx: any) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Array<(value: unknown) => void>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const emitted: Array<{ channel: string; value: unknown }> = [];
	let sessionName: string | undefined;
	let markdownTransformer: ((markdown: string, context: any) => string) | undefined;

	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerEntryRenderer() {},
		registerMarkdownTransformer(transformer: (markdown: string, context: any) => string) {
			markdownTransformer = transformer;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		getThinkingLevel() {
			return "high";
		},
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {};
			},
			emit(channel: string, value: unknown) {
				emitted.push({ channel, value });
				for (const handler of busHandlers.get(channel) ?? []) handler(value);
			},
		},
	};

	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		entries,
		emitted,
		getSessionName: () => sessionName,
		getMarkdownTransformer: () => markdownTransformer,
	};
}

async function invoke(harness: ReturnType<typeof createHarness>, event: string, payload: unknown, ctx: unknown) {
	let result: unknown;
	for (const handler of harness.handlers.get(event) ?? []) result = await handler(payload, ctx);
	return result;
}

function baseContext(overrides: Record<string, unknown> = {}) {
	let currentName: string | undefined;
	const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
	const footerCalls: unknown[] = [];
	const titles: string[] = [];
	const entries: unknown[] = [];
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			setTitle(title: string) { titles.push(title); },
			setWidget(key: string, content: string[] | undefined) { widgetCalls.push({ key, content }); },
			setFooter(factory: unknown) { footerCalls.push(factory); },
		},
		sessionManager: {
			getSessionName: () => currentName,
			getEntries: () => entries,
			getCwd: () => "/tmp/project",
		},
		setCurrentName(value: string | undefined) { currentName = value; },
		widgetCalls,
		footerCalls,
		titles,
		entries,
		...overrides,
	};
}

describe("extension lifecycle integration", () => {
	it("session-meta injects the protocol, strips envelopes, names the session, and appends recap", async () => {
		const harness = createHarness();
		sessionMeta(harness.api);
		const ctx = baseContext();
		await invoke(harness, "session_start", { type: "session_start" }, ctx);
		const before = { type: "before_agent_start", systemPromptOptions: { sections: {} as Record<string, string> } };
		await invoke(harness, "before_agent_start", before, ctx);
		assert.match(before.systemPromptOptions.sections.pi_utils_session_meta, /PI_UTILS_META_V1/);

		const message = {
			role: "assistant",
			content: [{ type: "text", text: [
				'@@PI_UTILS_META_V1@@{"v":1,"kind":"start","title":"Build utilities","sessionName":"Improve pi-utils"}',
				"Done.",
				'@@PI_UTILS_META_V1@@{"v":1,"kind":"end","recap":"Implemented the utilities"}',
			].join("\n") }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			provider: "test",
			model: "test",
			api: "test",
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const result = await invoke(harness, "message_end", { type: "message_end", message }, ctx) as { message?: typeof message };
		assert.equal(result.message?.content[0]?.text, "Done.");
		assert.equal(harness.getSessionName(), "Improve pi-utils");
		assert.equal(harness.entries[0]?.type, "pi-utils:session-meta:recap");
		assert.equal(harness.getMarkdownTransformer()?.("plain", { messageType: "assistant", isStreaming: false }), "plain");
	});

	it("tool-activity renders concurrent work and clears on settle", async () => {
		const harness = createHarness();
		toolActivity(harness.api);
		const ctx = baseContext();
		await invoke(harness, "session_start", { type: "session_start" }, ctx);
		await invoke(harness, "agent_start", { type: "agent_start" }, ctx);
		await invoke(harness, "tool_execution_start", { toolCallId: "1", toolName: "read" }, ctx);
		await invoke(harness, "tool_execution_start", { toolCallId: "2", toolName: "bash" }, ctx);
		assert.match(ctx.widgetCalls.at(-1)?.content?.[0] ?? "", /Running tools \(2\)/);
		await invoke(harness, "agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(ctx.widgetCalls.at(-1)?.content, undefined);
	});

	it("turn-metrics appends and publishes one settled run", async () => {
		const harness = createHarness();
		turnMetrics(harness.api);
		const ctx = baseContext();
		await invoke(harness, "agent_start", { type: "agent_start" }, ctx);
		await invoke(harness, "tool_execution_start", { type: "tool_execution_start" }, ctx);
		ctx.entries.push({
			type: "message",
			message: { role: "assistant", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
		});
		await invoke(harness, "agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(harness.entries[0]?.type, "pi-utils:turn-metrics:summary");
		assert.equal(harness.emitted[0]?.channel, "pi-utils/turn-metrics/updated/v1");
	});

	it("statusline is the only extension that registers and clears a footer", async () => {
		const harness = createHarness();
		statusline(harness.api);
		const ctx = baseContext({
			isProjectTrusted: () => false,
			modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined },
			getContextUsage: () => undefined,
		});
		await invoke(harness, "session_start", { type: "session_start" }, ctx);
		assert.equal(typeof ctx.footerCalls.at(-1), "function");
		await invoke(harness, "session_shutdown", { type: "session_shutdown" }, ctx);
		assert.equal(ctx.footerCalls.at(-1), undefined);
	});
});
