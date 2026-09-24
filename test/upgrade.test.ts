import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionMeta from "../extensions/session-meta/index.ts";
import turnMetrics from "../extensions/turn-metrics/index.ts";
import toolActivity from "../extensions/tool-activity/index.ts";
import statusline from "../extensions/statusline/index.ts";
import { branchRecaps, recapMarkdown } from "../extensions/session-meta/core.ts";
import { summarizeMetrics } from "../extensions/turn-metrics/summary.ts";

function harness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const appended: Array<{ type: string; data: any }> = [];
	const api = {
		on(event: string, fn: (event: any, ctx: any) => any) { handlers.set(event, [...handlers.get(event) ?? [], fn]); },
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, options.handler); },
		registerEntryRenderer() {}, registerMarkdownTransformer() {},
		appendEntry(type: string, data: any) { appended.push({ type, data }); },
		events: { emit() {}, on() {} },
		getThinkingLevel: () => "off",
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { api: api as unknown as ExtensionAPI, commands, appended, emit };
}
function context(cwd: string) {
	const entries: any[] = [];
	const notifications: string[] = [];
	const widgets: Array<string[] | undefined> = [];
	const footers: any[] = [];
	return { cwd, mode: "tui", hasUI: true, isProjectTrusted: () => false, entries, notifications, widgets, footers,
		ui: { notify: (text: string) => notifications.push(text), setWidget: (_: string, lines: string[] | undefined) => widgets.push(lines),
			setFooter: (factory: any) => footers.push(factory), setTitle() {} },
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getCwd: () => cwd, getSessionName: () => undefined },
		model: { id: "model", provider: "test", reasoning: false },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 10, percent: 1 }),
	};
}
describe("upgrade integration", () => {
	it("reports only validated current-branch metrics and recap entries", () => {
		const data = { durationMs: 2000, firstTokenMs: 100, toolCalls: 1, tools: [{ name: "read", durationMs: 60 }], maxConcurrentTools: 1,
			retries: 1, compactions: 1, status: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, completedAt: Date.now() };
		const entries = [ { type: "custom", customType: "pi-utils:turn-metrics:summary", data },
			{ type: "custom", customType: "pi-utils:turn-metrics:summary", data: { ...data, tools: [{ name: "secret\narg", durationMs: 1 }] } },
			{ type: "custom", customType: "pi-utils:session-meta:recap", data: { recap: "done", createdAt: 1 } },
			{ type: "message", message: { content: "raw transcript secret" } } ];
		assert.match(summarizeMetrics(entries), /1 settled run\(s\).*1 retries.*1 compactions.*100ms.*tool time read 60ms/);
		const legacy = { durationMs: 1000, toolCalls: 1, usage: data.usage, completedAt: 1 };
		assert.match(summarizeMetrics([{ type: "custom", customType: "pi-utils:turn-metrics:summary", data: legacy }]), /1 settled run\(s\)/);
		assert.deepEqual(branchRecaps(entries), ["done"]);
		assert.doesNotMatch(recapMarkdown(branchRecaps(entries)), /secret/);
	});
	it("exports only current-branch recaps into an existing directory, exclusively and within the workspace", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-utils-export-"));
		mkdirSync(join(root, "notes"));
		const outside = mkdtempSync(join(tmpdir(), "pi-utils-outside-"));
		t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
		symlinkSync(outside, join(root, "link"));
		const h = harness(); sessionMeta(h.api);
		const ctx = context(root);
		ctx.entries.push({ type: "custom", customType: "pi-utils:session-meta:recap", data: { recap: "done", createdAt: 1 } });
		const command = h.commands.get("utils-recap")!;
		await command("", ctx as any);
		assert.match(ctx.notifications.at(-1)!, /done/);
		for (const bad of ["export ../escape.md", "export link/escape.md", "export /tmp/escape.md", "export notes/../escape.md", "export notes/data.txt"]) {
			await command(bad, ctx as any);
			assert.match(ctx.notifications.at(-1)!, /Expected|failed/);
		}
		await command("export notes/recap.md", ctx as any);
		assert.match(ctx.notifications.at(-1)!, /Expected|failed/);
		await command("export recap.md", ctx as any);
		assert.match(readFileSync(join(root, "recap.md"), "utf8"), /done/);
		assert.equal(existsSync(join(outside, "escape.md")), false);
		await command("export recap.md", ctx as any);
		assert.match(ctx.notifications.at(-1)!, /failed/);
	});
	it("counts concurrent tools, first token, retry and compaction at settlement; stats are read-only", async () => {
		const h = harness(); turnMetrics(h.api);
		const ctx = context(tmpdir());
		await h.emit("agent_start", {}, ctx);
		await h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" }, ctx);
		await h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" }, ctx);
		await h.emit("tool_execution_end", { toolCallId: "a" }, ctx);
		await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, ctx);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } }, ctx);
		await h.emit("session_compact", { willRetry: true }, ctx);
		await h.emit("agent_start", {}, ctx);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await h.emit("agent_settled", {}, ctx);
		const data = h.appended.at(-1)!.data;
		assert.equal(data.toolCalls, 2);
		assert.equal(data.tools.length, 2);
		assert.equal(data.maxConcurrentTools, 2);
		assert.equal(data.retries, 1);
		assert.equal(data.compactions, 1);
		assert.equal(data.status, "completed");
		assert.ok(data.firstTokenMs >= 0);
		ctx.entries.push({ type: "custom", customType: h.appended[0]!.type, data });
		await h.commands.get("utils-stats")!("", ctx as any);
		assert.match(ctx.notifications.at(-1)!, /1 settled run/);
		assert.equal(h.appended.length, 1);
	});
	it("uses only trusted project settings for opt-in notifications and footer fields", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-utils-config-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, ".pi"));
		writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ piUtils: {
			notifications: { settleMs: 1000, userWaitMs: 1000 },
			statusline: { showQuota: false, showCost: false, showCache: false, showDuration: false },
		} }));
		const h = harness(); turnMetrics(h.api);
		const ctx = context(root);
		await h.emit("agent_start", {}, ctx);
		await h.emit("ui_prompt_start", {}, ctx);
		await h.emit("ui_prompt_end", {}, ctx);
		await h.emit("agent_settled", {}, ctx);
		assert.equal(ctx.notifications.length, 0);
		const trusted = { ...ctx, isProjectTrusted: () => true };
		trusted.entries.push({ type: "message", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 10, cost: { total: 1.25 } } } });
		const s = harness(); statusline(s.api);
		await s.emit("session_start", {}, trusted);
		const footer = trusted.footers.at(-1)({ requestRender() {} }, { fg: (_: string, text: string) => text }, {
			onBranchChange: () => () => {}, getGitBranch: () => null,
			getExtensionStatuses: () => new Map([["pi-sinan-usage", "quota"], ["pi-sinan-fast", "fast requested"]]), getAvailableProviderCount: () => 1,
		});
		assert.doesNotMatch(footer.render(120).join(" "), /quota|\$1\.250|R50|W10|CH/);
		assert.match(footer.render(120).join(" "), /fast requested/);
		const original = Date.now;
		let now = 10000;
		Date.now = () => now;
		try {
			await h.emit("agent_start", {}, trusted);
			await h.emit("ui_prompt_start", {}, trusted);
			await new Promise((resolve) => setTimeout(resolve, 1050));
			assert.match(ctx.notifications.at(-1)!, /Waiting for input/);
			now += 1500;
			await h.emit("ui_prompt_end", {}, trusted);
			await h.emit("agent_settled", {}, trusted);
		} finally { Date.now = original; }
		assert.equal(ctx.notifications.length, 2);
		assert.match(ctx.notifications[0]!, /Waiting for input/);
		assert.match(ctx.notifications[1]!, /Run settled/);
	});
	it("shows phase and counts without escalating a failed tool; renders configurable footer tiers", async () => {
		const a = harness(); toolActivity(a.api);
		const ctx = context(tmpdir());
		await a.emit("agent_start", {}, ctx);
		assert.match(ctx.widgets.at(-1)?.[0] ?? "", /Agent working/);
		await a.emit("before_provider_request", {}, ctx);
		assert.match(ctx.widgets.at(-1)?.[0] ?? "", /Provider working/);
		await a.emit("tool_execution_start", { toolCallId: "x", toolName: "bash\u001b[31m" }, ctx);
		assert.doesNotMatch(ctx.widgets.at(-1)?.[0] ?? "", /\u001b/);
		await a.emit("tool_execution_end", { toolCallId: "x", isError: true }, ctx);
		assert.match(ctx.widgets.at(-1)?.[0] ?? "", /1 done \/ 0 running/);
		assert.doesNotMatch(ctx.widgets.at(-1)?.[0] ?? "", /failed bash|problem|urgent/i);
		await a.emit("agent_settled", {}, ctx);
		await a.emit("ui_prompt_start", { kind: "input", title: "secret input" }, ctx);
		assert.match(ctx.widgets.at(-1)?.[0] ?? "", /User wait · input/);
		assert.doesNotMatch(ctx.widgets.at(-1)?.[0] ?? "", /secret/);
		await a.emit("ui_prompt_end", {}, ctx);
		assert.equal(ctx.widgets.at(-1), undefined);
		const s = harness(); statusline(s.api);
		await s.emit("session_start", {}, ctx);
		const footer = ctx.footers.at(-1)({ requestRender() {} }, { fg: (_: string, text: string) => text }, {
			onBranchChange: () => () => {}, getGitBranch: () => null,
			getExtensionStatuses: () => new Map([["pi-sinan-usage", "quota"], ["pi-sinan-fast", "fast"]]), getAvailableProviderCount: () => 1,
		});
		for (const width of [120, 50, 12]) assert.ok(footer.render(width).every((line: string) => line.length <= width + 2));
		assert.match(footer.render(120)[1], /10 1%/);
		assert.match(footer.render(120)[1], /quota.*fast/);
	});
	it("measures active tool time rather than the age of the agent run", async () => {
		const h = harness(); toolActivity(h.api);
		const ctx = context(tmpdir());
		const original = Date.now;
		let now = 10000;
		Date.now = () => now;
		try {
			await h.emit("agent_start", {}, ctx);
			now += 60000;
			await h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" }, ctx);
			now += 2000;
			await h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" }, ctx);
			assert.match(ctx.widgets.at(-1)?.[0] ?? "", /Tools.*2s/);
			assert.doesNotMatch(ctx.widgets.at(-1)?.[0] ?? "", /62s/);
		} finally {
			await h.emit("session_shutdown", {}, ctx);
			Date.now = original;
		}
	});
	it("measures user wait from prompt start rather than the whole running turn", async () => {
		const h = harness(); toolActivity(h.api);
		const ctx = context(tmpdir());
		const original = Date.now;
		let now = 10000;
		Date.now = () => now;
		try {
			await h.emit("agent_start", {}, ctx);
			now += 10000;
			await h.emit("ui_prompt_start", { kind: "input" }, ctx);
			now += 1500;
			await h.emit("tool_execution_start", { toolCallId: "during-wait", toolName: "read" }, ctx);
			assert.match(ctx.widgets.at(-1)?.[0] ?? "", /User wait.*1s/);
			assert.doesNotMatch(ctx.widgets.at(-1)?.[0] ?? "", /11s/);
		} finally {
			await h.emit("session_shutdown", {}, ctx);
			Date.now = original;
		}
	});
});
