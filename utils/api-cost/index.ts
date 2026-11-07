import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCodexSubscription } from "../quota/core.ts";
import { costPeriods, fetchCosts, formatCosts, isOpenAICostRoute, resolveCostKeyId } from "./core.ts";

export const API_COST_STATUS = "pi-utils:api-cost";
const REFRESH_MS = 5 * 60_000;

async function subscriptionToken(ctx: ExtensionContext): Promise<{ token?: string; reason?: string }> {
  const model = ctx.modelRegistry.getAll().find(model =>
    isCodexSubscription(model, ctx.modelRegistry.isUsingOAuth(model)));
  if (!model) return { reason: "未找到已登录的官方 Codex 订阅渠道" };
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return { reason: "Codex 登录认证不可用" };
    if (!isCodexSubscription({ ...model, baseUrl: auth.baseUrl ?? model.baseUrl }, true)) {
      return { reason: "Codex 认证并非官方路由，未读取订阅日期" };
    }
    return { token: auth.apiKey };
  } catch {
    return { reason: "Codex 登录认证失败，未取得订阅日期" };
  }
}

export function registerApiCost(pi: ExtensionAPI, redraw: () => void = () => {}): void {
  let context: ExtensionContext | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let identity: string | undefined;
  let attemptedAt = 0;
  let status: string | undefined;
  const publish = (ctx: ExtensionContext, text: string | undefined) => {
    status = text;
    if (ctx.mode === "tui") { ctx.ui.setStatus(API_COST_STATUS, text); redraw(); }
  };
  const reset = (ctx: ExtensionContext) => {
    generation++;
    controller?.abort(); controller = undefined;
    identity = undefined; attemptedAt = 0;
    publish(ctx, undefined);
  };
  const refresh = async (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (ctx.mode !== "tui") return;
    if (model?.provider !== "openai") { reset(ctx); return; }
    if (controller) return;
    if (!isOpenAICostRoute(model) || ctx.modelRegistry.isUsingOAuth(model)) {
      publish(ctx, "cost:n/a"); return;
    }
    const active = new AbortController();
    controller = active;
    const version = generation;
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(60_000)]);
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => undefined);
      if (version !== generation) return;
      if (!auth?.ok || !auth.apiKey) { publish(ctx, "cost:auth"); return; }
      if (!isOpenAICostRoute({ ...model, baseUrl: auth.baseUrl ?? model.baseUrl })) {
        publish(ctx, "cost:n/a"); return;
      }
      const adminKey = process.env.OPENAI_ADMIN_KEY?.trim();
      if (!adminKey) { publish(ctx, "cost:auth"); return; }
      // 统计对象来自宿主当前 Provider，而不是另一份 OPENAI_API_KEY 配置。
      const fingerprint = createHash("sha256").update(`${auth.apiKey}\0${adminKey}`).digest("hex");
      if (identity !== fingerprint) {
        identity = fingerprint; attemptedAt = 0;
        publish(ctx, undefined);
      }
      if (Date.now() - attemptedAt < REFRESH_MS && status) return;
      attemptedAt = Date.now();
      publish(ctx, "cost:...");
      const keyId = await resolveCostKeyId(auth.apiKey, adminKey, signal);
      signal.throwIfAborted();
      const subscription = await subscriptionToken(ctx);
      signal.throwIfAborted();
      const periods = costPeriods(subscription.token, Date.now(), subscription.reason);
      const results = [];
      for (const period of periods.periods) results.push(await fetchCosts({ adminKey, keyId }, period, signal));
      if (version !== generation) return;
      // 订阅区间与 7d/30d 回退互斥；状态栏只显示金额和覆盖天数。
      publish(ctx, formatCosts(results));
    } catch {
      if (version !== generation) return;
      // 失败保留明确短标记，不把错误正文铺满额度位置，也不冒充零费用。
      publish(ctx, "cost:err");
    } finally {
      if (controller === active) controller = undefined;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined; context = ctx; reset(ctx);
    if (ctx.mode !== "tui") return;
    void refresh(ctx);
    // 每分钟检查当前认证，费用请求限频为五分钟；不会把旧 Key 的快照给新 Key。
    timer = setInterval(() => { if (context) void refresh(context); }, 60_000);
    timer.unref();
  });
  pi.on("model_select", (_event, ctx) => { context = ctx; reset(ctx); void refresh(ctx); });
  pi.on("agent_start", (_event, ctx) => { context = ctx; void refresh(ctx); });
  pi.on("agent_settled", (_event, ctx) => { context = ctx; void refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined; context = undefined; reset(ctx);
  });
}
