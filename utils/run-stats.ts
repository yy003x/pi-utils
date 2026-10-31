import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface RunStats {
  durationMs: number;
  toolCalls: number;
  status: "running" | "completed" | "error" | "aborted" | "length" | "unknown";
  usage: TokenUsage;
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
export function usageOf(entries: readonly SessionEntry[]): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
    if (usage) for (const key of Object.keys(total) as (keyof TokenUsage)[]) total[key] += usage[key];
  }
  return total;
}
export class RunTracker {
  private startedAt: number | undefined;
  private before: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private tools = new Set<string>();
  private status: RunStats["status"] = "unknown";
  start(now: number, usage: TokenUsage): void {
    // 自动重试可多次触发 agent_start；只在整个运行首次开始时计时。
    if (this.startedAt !== undefined) return;
    this.startedAt = now;
    this.before = { ...usage };
  }
  tool(id: string): void { if (this.startedAt !== undefined) this.tools.add(id); }
  message(reason: string): void {
    if (this.startedAt === undefined) return;
    this.status = reason === "stop" ? "completed"
      : reason === "error" || reason === "aborted" || reason === "length" ? reason : "unknown";
  }
  snapshot(now: number, after: TokenUsage, aborted?: boolean): RunStats | undefined {
    if (this.startedAt === undefined) return undefined;
    const usage = { ...after };
    for (const key of Object.keys(usage) as (keyof TokenUsage)[]) usage[key] = Math.max(0, after[key] - this.before[key]);
    return { durationMs: Math.max(0, now - this.startedAt), toolCalls: this.tools.size,
      status: aborted === undefined ? "running" : aborted ? "aborted" : this.status, usage };
  }
}
const labels: Record<RunStats["status"], string> = {
  running: "运行中", completed: "完成", error: "失败", aborted: "已中止", length: "长度受限", unknown: "已结束",
};
export function formatRun(run: RunStats): string {
  const tokens = run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
  return `${labels[run.status]} ${duration(run.durationMs)} · 工具 ${run.toolCalls} · tokens ${tokens}`;
}
export function registerRunStats(pi: ExtensionAPI, redraw: () => void): () => RunStats | undefined {
  let tracker = new RunTracker();
  let latest: RunStats | undefined;
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };
  const current = () => context
    ? tracker.snapshot(Date.now(), usageOf(context.sessionManager.getEntries())) ?? latest : latest;
  const reset = () => { stopTimer(); tracker = new RunTracker(); latest = undefined; context = undefined; redraw(); };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    tracker.start(Date.now(), usageOf(ctx.sessionManager.getEntries()));
    if (ctx.mode === "tui" && !timer) { timer = setInterval(redraw, 1000); timer.unref(); }
    redraw();
  });
  pi.on("tool_execution_start", event => { tracker.tool(event.toolCallId); redraw(); });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") tracker.message(event.message.stopReason);
  });
  pi.on("agent_settled", (event, ctx) => {
    latest = tracker.snapshot(Date.now(), usageOf(ctx.sessionManager.getEntries()), event.aborted) ?? latest;
    tracker = new RunTracker(); context = undefined; stopTimer(); redraw();
  });
  pi.registerCommand("run-stats", { description: "查看当前或最近一次运行的耗时、工具次数和 token 用量", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return;
    const run = current();
    ctx.ui.notify(run ? `${formatRun(run)}\n输入 ${run.usage.input} · 输出 ${run.usage.output} · 缓存读取 ${run.usage.cacheRead} · 缓存写入 ${run.usage.cacheWrite}` : "暂无运行统计", "info");
  } });
  return current;
}
