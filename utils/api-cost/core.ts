export const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const DAY = 86_400;

export interface CostPeriod { label: string; start: number; end: number }
export interface CostPeriods { periods: CostPeriod[]; reason?: string }
export interface CostResult extends CostPeriod { usd: number }
export interface CostConfig { adminKey: string; keyId: string }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isOpenAICostRoute(model: { provider: string; baseUrl: string } | undefined): boolean {
  if (model?.provider !== "openai") return false;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === "https://api.openai.com" && ["/v1", "/v1/"].includes(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function validKeyId(keyId: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(keyId) && !keyId.startsWith("sk-");
}

export function matchesKey(apiKey: string, redacted: unknown): boolean {
  if (typeof redacted !== "string" || !apiKey) return false;
  if (redacted === apiKey) return true;
  const parts = redacted.split(/\.{3}|…|\*+/);
  return parts.length === 2 && parts[0].length >= 3 && parts[1].length >= 4
    && apiKey.length > parts[0].length + parts[1].length
    && apiKey.startsWith(parts[0]) && apiKey.endsWith(parts[1]);
}

export function uniqueKeyId(ids: string[]): string {
  // 脱敏前后缀匹配不是完整密钥验证；有任何可见歧义都停止，不猜测目标。
  if (ids.length !== 1 || !validKeyId(ids[0])) {
    throw new CostQueryError(ids.length > 1 ? "Ambiguous provider key match" : "Provider key not found in Admin organization");
  }
  return ids[0];
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function costPeriods(token: string | undefined, now = Date.now(), unavailable = "Codex 登录信息不可用"): CostPeriods {
  const end = Math.floor(now / 1000);
  let reason = unavailable;
  if (token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const payload = object(JSON.parse(Buffer.from(parts[1], "base64url").toString()));
      const claims = object(payload?.["https://api.openai.com/auth"]);
      const start = timestamp(claims?.chatgpt_subscription_active_start);
      const until = timestamp(claims?.chatgpt_subscription_active_until);
      // iat/exp 是令牌时间，不是订阅时间；只将 exp 用于排除过期令牌。
      if (typeof payload?.exp !== "number" || payload.exp <= end) reason = "Codex 登录令牌已过期";
      else if (claims?.chatgpt_plan_type === "free") reason = "Codex 当前没有付费订阅";
      else if (start === undefined || until === undefined || start >= end || until <= start) reason = "Codex 登录信息缺少有效订阅起止日期";
      else if (until <= end) reason = "Codex 订阅已失效";
      else return { periods: [{ label: "订阅起点至今", start, end }] };
    } catch {
      reason = "Codex 登录信息无法解析";
    }
  }
  // 回退窗口采用固定天数，与状态栏的 7d/30d 完全一致，不按日历月换算。
  return { reason, periods: [
    { label: "最近7天", start: end - 7 * DAY, end },
    { label: "最近30天", start: end - 30 * DAY, end },
  ] };
}

export function costsUrl(period: CostPeriod, keyId: string, page?: string): URL {
  if (!Number.isSafeInteger(period.start) || !Number.isSafeInteger(period.end) || period.start < 0 || period.start >= period.end) {
    throw new Error("费用查询时间范围无效");
  }
  // 缺少单 Key 过滤时绝不请求组织合计，也不接受密钥正文作为 ID。
  if (!validKeyId(keyId)) throw new Error("费用查询需要有效的单个 Key ID");
  const url = new URL(COSTS_URL);
  url.searchParams.set("start_time", String(period.start));
  url.searchParams.set("end_time", String(period.end));
  url.searchParams.set("api_key_ids[]", keyId);
  url.searchParams.set("group_by[]", "api_key_id");
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "180");
  if (page) url.searchParams.set("page", page);
  return url;
}

export function parseCostsPage(value: unknown, keyId: string): { usd: number; next?: string } {
  const page = object(value);
  if (page?.object !== "page" || !Array.isArray(page.data) || typeof page.has_more !== "boolean") {
    throw new Error("费用接口返回格式无效");
  }
  let usd = 0;
  for (const item of page.data) {
    const bucket = object(item);
    if (!Array.isArray(bucket?.results)) throw new Error("费用时间桶格式无效");
    for (const row of bucket.results) {
      const result = object(row);
      const amount = object(result?.amount);
      // 分组返回的 Key 必须精确匹配；拒绝未归属费用，不能把组织费用当作 Key 费用。
      if (result?.object !== "organization.costs.result" || result.api_key_id !== keyId) {
        throw new Error("费用接口未返回指定 Key 的独立费用，已拒绝汇总");
      }
      if (amount?.currency !== "usd" || typeof amount.value !== "number" || !Number.isFinite(amount.value)) {
        throw new Error("费用金额或币种无效");
      }
      usd += amount.value;
    }
  }
  if (!Number.isFinite(usd)) throw new Error("费用金额超出范围");
  if (page.has_more && (typeof page.next_page !== "string" || !page.next_page.trim())) {
    throw new Error("费用分页信息缺失，无法完成统计");
  }
  return { usd, next: page.has_more ? page.next_page as string : undefined };
}

export class CostQueryError extends Error {}

export function parseKeyList(value: unknown): { data: Record<string, unknown>[]; next?: string } {
  const page = object(value);
  if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean"
    || page.data.some(item => !object(item) || typeof item.id !== "string")
    || (page.has_more && (typeof page.last_id !== "string" || !page.last_id))) {
    throw new CostQueryError("Invalid Admin key metadata response");
  }
  return { data: page.data, next: page.has_more ? page.last_id as string : undefined };
}

async function* adminItems(path: string, adminKey: string, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const url = new URL(`https://api.openai.com/v1${path}`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after", cursor);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
    } catch { throw new CostQueryError("Admin metadata request failed (network/timeout/redirect)"); }
    if (!response.ok) throw new CostQueryError(`Admin metadata HTTP ${response.status}; check project/key read permissions`);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new CostQueryError("Invalid Admin metadata JSON"); }
    const page = parseKeyList(value);
    yield* page.data;
    cursor = page.next;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 1000) throw new CostQueryError("Invalid Admin metadata pagination");
      seen.add(cursor);
    }
  } while (cursor);
}

export async function resolveCostKeyId(apiKey: string, adminKey: string, signal: AbortSignal): Promise<string> {
  if (!apiKey || !adminKey) throw new CostQueryError("Provider key or OPENAI_ADMIN_KEY missing");
  const ids: string[] = [];
  for await (const project of adminItems("/organization/projects", adminKey, signal)) {
    for await (const key of adminItems(`/organization/projects/${encodeURIComponent(project.id as string)}/api_keys`, adminKey, signal)) {
      if (matchesKey(apiKey, key.redacted_value)) ids.push(key.id as string);
    }
  }
  return uniqueKeyId(ids);
}

export async function fetchCosts(config: CostConfig, period: CostPeriod, signal: AbortSignal): Promise<CostResult> {
  let usd = 0;
  let page: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      signal.throwIfAborted();
      const response = await fetch(costsUrl(period, config.keyId, page), {
        headers: { Authorization: `Bearer ${config.adminKey}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? "；请检查 Admin Key 及同组织查询权限" : "";
        throw new CostQueryError(`费用查询失败（HTTP ${response.status}）${hint}`);
      }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new CostQueryError("费用接口未返回有效 JSON"); }
      let result: ReturnType<typeof parseCostsPage>;
      try { result = parseCostsPage(value, config.keyId); }
      catch (error) { throw new CostQueryError((error as Error).message); }
      usd += result.usd;
      page = result.next;
      if (page) {
        if (seen.has(page) || seen.size >= 1000) throw new CostQueryError("费用接口分页异常，未显示不完整统计");
        seen.add(page);
      }
    } while (page);
    if (!Number.isFinite(usd)) throw new CostQueryError("费用金额超出范围");
    return { ...period, usd };
  } catch (error) {
    if (error instanceof CostQueryError) throw error;
    // 网络错误、重定向和响应正文可能含凭据或账户信息，禁止透传。
    throw new CostQueryError(signal.aborted ? "费用查询已取消或超时" : "费用查询失败（网络错误、超时或重定向被拒绝）");
  }
}

export function formatCosts(results: CostResult[]): string {
  return results.map(row => {
    // N 表示本次查询从起点至今覆盖的天数，不足一天向上取整；不是完整套餐周期。
    const days = Math.max(1, Math.ceil((row.end - row.start) / DAY));
    return `${row.usd.toFixed(4)}$/${days}d`;
  }).join(" ");
}
