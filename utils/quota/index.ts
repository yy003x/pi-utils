import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REFRESH_MS, STALE_MS, fetchCodexQuota, fetchGlmQuota, formatQuota, quotaDetails, isChatGPTSubscription, isCodexSubscription, isGlmCodingPlan, type QuotaSnapshot } from "./core.ts";

export const QUOTA_STATUS = "model-quota";
export function registerQuota(pi: ExtensionAPI, redraw: () => void): void {
  let context: ExtensionContext | undefined;
  let snapshot: QuotaSnapshot | undefined;
  let identity: string | undefined;
  let error: string | undefined;
  let attemptedAt = 0;
  let generation = 0;
  let running = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const channel = (ctx: ExtensionContext) => {
    if (!ctx.model) return undefined;
    if (isCodexSubscription(ctx.model, ctx.modelRegistry.isUsingOAuth(ctx.model))) return "codex";
    if (isGlmCodingPlan(ctx.model)) return "glm";
    return undefined;
  };
  const reset = () => {
    generation++;
    controller?.abort(); controller = undefined; pending = undefined;
    snapshot = undefined; identity = undefined; error = undefined; attemptedAt = 0;
  };
  const text = () => error ?? (snapshot ? formatQuota(snapshot, Date.now(), STALE_MS) : "额度读取中");
  const render = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const supported = channel(ctx);
    const native = ctx.model && isChatGPTSubscription(ctx.model, ctx.modelRegistry.isUsingOAuth(ctx.model));
    ctx.ui.setStatus(QUOTA_STATUS, supported ? text() : native ? "ChatGPT 订阅 · 额度接口未支持" : undefined);
    redraw();
  };
  const refresh = (ctx: ExtensionContext, force = false): Promise<void> => {
    context = ctx;
    const source = channel(ctx);
    if (!running || !source) { reset(); render(ctx); return Promise.resolve(); }
    if (pending) return pending;
    const version = generation;
    const model = ctx.model!;
    const abort = new AbortController();
    controller = abort;
    const task = (async () => {
      try {
        // 认证错误不透传底层异常，避免凭据进入通知或会话。
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => undefined);
        if (version !== generation || !running || channel(ctx) !== source) return;
        if (!auth?.ok || !auth.apiKey) throw new Error(source === "glm"
          ? "GLM API Key 不可用，请检查 zai-coding-cn 认证" : "登录凭据不可用，请检查 /login openai-codex");
        const route = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
        if (!(source === "codex" ? isCodexSubscription(route, true) : isGlmCodingPlan(route))) {
          throw new Error("认证路由不是官方渠道，已停止额度查询");
        }
        const fingerprint = createHash("sha256").update(`${source}\0${auth.apiKey}`).digest("hex");
        if (identity !== fingerprint) {
          identity = fingerprint; snapshot = undefined; error = undefined; attemptedAt = 0;
          render(ctx);
        }
        if (!force && Date.now() - attemptedAt < REFRESH_MS && (error || snapshot?.windows.every(window => Date.now() < window.resetAt))) {
          render(ctx); return;
        }
        attemptedAt = Date.now();
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
        const result = await (source === "codex" ? fetchCodexQuota(auth.apiKey, signal) : fetchGlmQuota(auth.apiKey, signal));
        if (version !== generation || !running || channel(ctx) !== source) return;
        snapshot = result; error = undefined;
      } catch (cause) {
        if (version !== generation || !running || abort.signal.aborted || channel(ctx) !== source) return;
        snapshot = undefined;
        error = cause instanceof Error && cause.name === "Error" ? cause.message : "额度查询失败（网络异常或超时）";
      } finally {
        if (version === generation && running) render(ctx);
      }
    })();
    const job = task.finally(() => { if (pending === job) { pending = undefined; controller = undefined; } });
    pending = job;
    return job;
  };
  pi.on("session_start", (_event, ctx) => {
    if (timer) clearInterval(timer);
    reset(); running = ctx.mode === "tui"; context = ctx;
    if (!running) return;
    render(ctx); void refresh(ctx);
    timer = setInterval(() => { if (context) void refresh(context, true); }, REFRESH_MS);
    timer.unref();
  });
  pi.on("model_select", (_event, ctx) => { reset(); if (running) { render(ctx); void refresh(ctx); } });
  pi.on("agent_start", (_event, ctx) => { if (running) void refresh(ctx); });
  pi.on("agent_settled", (_event, ctx) => { if (running) void refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    running = false; if (timer) clearInterval(timer); timer = undefined; context = undefined; reset();
    if (ctx.mode === "tui") ctx.ui.setStatus(QUOTA_STATUS, undefined);
  });
  pi.registerCommand("model-quota", {
    description: "刷新并查看当前 Codex / GLM 订阅额度与重置时间",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") { ctx.ui.notify("额度查询仅在交互终端中运行", "info"); return; }
      const source = channel(ctx);
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选模型";
      if (!source) {
        const native = ctx.model && isChatGPTSubscription(ctx.model, ctx.modelRegistry.isUsingOAuth(ctx.model));
        ctx.ui.notify(native ? quotaDetails("chatgpt", model) : "当前模型不属于支持的官方 Codex / GLM 渠道", "info");
        return;
      }
      const version = generation;
      await refresh(ctx, true);
      if (version !== generation || !running || channel(ctx) !== source) return;
      ctx.ui.notify(quotaDetails(source, model, snapshot, error), error ? "warning" : "info");
    },
  });
}
