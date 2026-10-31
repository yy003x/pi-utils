import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../utils/index.ts";
import { registerRunStats, type RunStats } from "../utils/run-stats.ts";

async function withHost(factory: (pi: ExtensionAPI) => void, verify: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], manager: SessionManager) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-utils-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(agentDir); mkdirSync(cwd);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
    settingsManager.setProjectTrusted(false);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [factory],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const manager = SessionManager.inMemory(cwd);
    ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, settingsManager, sessionManager: manager, tools: [] }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    await verify(session, manager);
    await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(errors, []);
    assert.equal(existsSync(join(agentDir, "auth.json")), false);
    assert.equal(existsSync(join(agentDir, "pi-utils.json")), false);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("真实 Pi 加载仅三个命令，无输入、prompt、Provider、工具改写 hook", async () => {
  await withHost(extension, async (session, manager) => {
    const runner = session.extensionRunner!;
    assert.deepEqual(runner.getRegisteredCommands().map(command => command.name).sort(), ["cd", "model-quota", "run-stats"]);
    assert.deepEqual(runner.getAllRegisteredTools(), []);
    for (const hook of ["input", "before_agent_start", "context", "context_with_system", "before_provider_request", "before_provider_headers", "tool_call", "tool_result", "user_bash", "agent_before_settle", "resources_discover"]) {
      assert.equal(runner.hasHandlers(hook), false, hook);
    }
    const before = structuredClone(manager.getEntries());
    const prompt = session.systemPrompt;
    await session.prompt("/run-stats");
    await session.prompt("/model-quota");
    await session.prompt("/cd");
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
    await runner.emit({ type: "agent_end", messages: [] });
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "agent_settled", aborted: false });
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.deepEqual(manager.getEntries(), before);
    assert.equal(session.systemPrompt, prompt);
  });
});

test("真实 SDK 分发验证统计跨 agent_end 保持，到 settled 才结束且不写会话", async () => {
  let stats!: () => RunStats | undefined;
  await withHost(pi => { stats = registerRunStats(pi, () => {}); }, async (session, manager) => {
    const runner = session.extensionRunner!;
    assert.equal(stats(), undefined);
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
    await runner.emit({ type: "agent_end", messages: [] });
    assert.equal(stats()?.status, "running");
    await runner.emit({ type: "agent_start" });
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "测试条目，并非模型调用结果" }],
      api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
      usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const original = structuredClone(message);
    assert.equal(await runner.emitMessageEnd({ type: "message_end", message }), undefined);
    assert.deepEqual(message, original);
    manager.appendMessage(message);
    const before = structuredClone(manager.getEntries());
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(stats()?.status, "completed");
    assert.equal(stats()?.toolCalls, 1);
    assert.deepEqual(stats()?.usage, { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 });
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(stats()?.toolCalls, 1);
    assert.deepEqual(manager.getEntries(), before);
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "agent_settled", aborted: true });
    assert.equal(stats()?.status, "aborted");
    assert.deepEqual(stats()?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    await runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(stats(), undefined);
  });
});
