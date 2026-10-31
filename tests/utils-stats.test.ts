import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { duration, formatRun, formatTokens, RunTracker, usageOf } from "../utils/run-stats.ts";

const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
test("跨 agent_start 连续计时，工具去重，结束状态与 token 增量正确", () => {
  const tracker = new RunTracker();
  assert.equal(tracker.snapshot(0, empty), undefined);
  tracker.tool("before-start");
  tracker.start(0, { ...empty, input: 100 });
  tracker.start(5000, { ...empty, input: 150 });
  tracker.tool("read-1"); tracker.tool("read-1"); tracker.tool("read-1/1");
  tracker.message("error");
  assert.equal(tracker.snapshot(6000, empty)?.status, "running");
  tracker.message("stop");
  const run = tracker.snapshot(6500, { input: 130, output: 7, cacheRead: 20, cacheWrite: 3 }, false)!;
  assert.deepEqual(run, { durationMs: 6500, toolCalls: 2, status: "completed", usage: { input: 30, output: 7, cacheRead: 20, cacheWrite: 3 } });
  assert.equal(formatRun(run), "done 6s tools:2 tokens:60");
  assert.equal(tracker.snapshot(7000, empty, true)?.status, "aborted");
});
test("token 沿用原生数量级压缩格式，单位使用小写 k/m", () => {
  for (const [count, expected] of [
    [0, "0"], [999, "999"], [1000, "1.0k"], [1250, "1.3k"],
    [9999, "10.0k"], [10_000, "10k"], [125_600, "126k"],
    [999_999, "1000k"], [1_000_000, "1.0m"], [1_250_000, "1.3m"],
    [10_000_000, "10m"], [125_600_000, "126m"],
  ] as const) assert.equal(formatTokens(count), expected);
  const run = { durationMs: 32_000, toolCalls: 8, status: "completed" as const,
    usage: { input: 100_000, output: 5600, cacheRead: 15_000, cacheWrite: 5000 } };
  assert.equal(formatRun(run), "done 32s tools:8 tokens:126k");
  assert.equal(run.usage.input, 100_000);
});
test("异常、截断、未终结 toolUse 不伪装为成功", () => {
  const tracker = new RunTracker();
  tracker.start(1000, empty);
  for (const [reason, status] of [["error", "error"], ["length", "length"], ["aborted", "aborted"], ["toolUse", "unknown"]]) {
    tracker.message(reason);
    assert.equal(tracker.snapshot(2000, empty, false)?.status, status);
  }
  assert.equal(duration(-1), "0s");
  assert.equal(duration(61_000), "1m1s");
  assert.equal(duration(3_661_000), "1h1m");
});
test("读取真实 SessionManager 的原生用量条目，不计入展示型自定义数据", () => {
  const manager = SessionManager.inMemory();
  const usage = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  manager.appendUsage("cache_warm", "test", "test", usage);
  manager.appendCompaction("summary", null, 17, undefined, false, usage);
  manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "test", content: [], isError: false, timestamp: 1, usage });
  manager.appendCustomEntry("unrelated", { usage });
  const before = manager.getEntries();
  assert.deepEqual(usageOf(before), { input: 6, output: 9, cacheRead: 15, cacheWrite: 21 });
  assert.deepEqual(manager.getEntries(), before);
});
