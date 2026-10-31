export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const GLM_USAGE_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
export const REFRESH_MS = 60_000;
export const STALE_MS = 2 * REFRESH_MS;

export interface ModelRoute {
  provider: string;
  api: string;
  baseUrl: string;
}

function officialUrl(value: string, origin: string, path: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && (url.pathname === path || url.pathname === `${path}/`)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isCodexSubscription(model: ModelRoute | undefined, usingOAuth: boolean): boolean {
  return !!model && usingOAuth && model.provider === 'openai-codex'
    && model.api === 'openai-codex-responses'
    && officialUrl(model.baseUrl, 'https://chatgpt.com', '/backend-api');
}

export function isGlmCodingPlan(model: ModelRoute | undefined): boolean {
  if (!model || model.provider !== 'zai-coding-cn' || model.api !== 'openai-completions') return false;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === 'https://open.bigmodel.cn'
      && (url.pathname === '/api/coding/paas/v4' || url.pathname.startsWith('/api/coding/paas/v4/'))
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isChatGPTSubscription(model: ModelRoute | undefined, usingOAuth: boolean): boolean {
  return isCodexSubscription(model, usingOAuth) || (!!model && usingOAuth
    && model.provider === 'openai' && model.api === 'openai-responses'
    && officialUrl(model.baseUrl, 'https://api.openai.com', '/v1'));
}

export interface QuotaWindow {
  seconds: number;
  remaining: number;
  resetAt: number;
  label?: string;
}

export interface QuotaSnapshot {
  windows: QuotaWindow[];
  fetchedAt: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parseCodexQuota(value: unknown, now = Date.now()): QuotaSnapshot {
  const limits = object(object(value)?.rate_limit);
  const windows: QuotaWindow[] = [];
  for (const key of ['primary_window', 'secondary_window']) {
    const window = object(limits?.[key]);
    if (!window) continue;
    const used = window.used_percent;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0
      || !positive(window.limit_window_seconds) || !positive(window.reset_at)) {
      throw new Error('Invalid quota window');
    }
    windows.push({
      seconds: window.limit_window_seconds,
      remaining: Math.max(0, 100 - used),
      resetAt: window.reset_at * 1000,
    });
  }
  if (windows.length === 0) throw new Error('No displayable Codex quota window');
  return { windows, fetchedAt: now };
}

function periodLabel(seconds: number): string {
  if (seconds % 604800 === 0) return `${seconds / 604800}w`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.ceil(seconds / 60)}m`;
}

export function formatQuota(snapshot: QuotaSnapshot, now = Date.now(), staleMs = STALE_MS): string {
  return snapshot.windows.map(window => {
    // 窗口到期不代表已经恢复满额，必须等待服务端的新快照。
    const remaining = now >= window.resetAt || now - snapshot.fetchedAt >= staleMs
      ? 'stale' : `${Number(window.remaining.toFixed(1))}%`;
    const hours = Math.max(0, Math.ceil((window.resetAt - now) / 3_600_000));
    return `${remaining}/${window.label ?? periodLabel(window.seconds)}/${hours}h`;
  }).join(' · ');
}

async function readQuotaResponse(response: Response): Promise<unknown> {
  // 不输出响应正文，避免认证失败页或服务端错误携带个人信息。
  if (!response.ok) throw new Error(`Quota request failed (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error('Invalid quota response JSON');
  }
}

export async function fetchCodexQuota(apiKey: string, signal: AbortSignal): Promise<QuotaSnapshot> {
  let accountId: unknown;
  try {
    const claims = JSON.parse(Buffer.from(apiKey.split('.')[1] ?? '', 'base64url').toString());
    accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch {
    throw new Error('Invalid Codex login credentials; log in again');
  }
  if (typeof accountId !== 'string' || !accountId) throw new Error('Codex login credentials lack account information');
  const response = await fetch(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'ChatGPT-Account-Id': accountId,
      Accept: 'application/json',
    },
    redirect: 'error',
    signal,
  });
  return parseCodexQuota(await readQuotaResponse(response));
}

// GLM Coding Plan 的额度单位：unit 3 为小时，unit 6 为周。
const GLM_UNIT_SECONDS: Record<number, number> = { 3: 3600, 6: 604800 };

export function parseGlmQuota(value: unknown, now = Date.now()): QuotaSnapshot {
  const payload = object(object(value)?.data) ?? object(value);
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  const windows: QuotaWindow[] = [];
  for (const item of limits) {
    const limit = object(item);
    if (!limit || limit.type !== 'CREDIT_LIMIT') continue;
    const usage = limit.usage;
    const remainingValue = limit.remaining;
    const unitSeconds = limit.unit === 3 || limit.unit === 6 ? GLM_UNIT_SECONDS[limit.unit] : undefined;
    const number = limit.number;
    if (!positive(usage) || typeof remainingValue !== 'number' || !Number.isFinite(remainingValue)
      || remainingValue < 0 || remainingValue > usage
      || !positive(limit.nextResetTime) || !unitSeconds || !positive(number)) {
      throw new Error('Invalid quota window');
    }
    const seconds = number * unitSeconds;
    windows.push({
      seconds,
      remaining: remainingValue / usage * 100,
      resetAt: limit.nextResetTime,
      ...(seconds === 18000 ? { label: '5h' } : {}),
      ...(seconds === 604800 ? { label: '7d' } : {}),
    });
  }
  if (windows.length === 0) throw new Error('No recognizable GLM quota window');
  windows.sort((a, b) => a.resetAt - b.resetAt);
  return { windows, fetchedAt: now };
}

export async function fetchGlmQuota(apiKey: string, signal: AbortSignal): Promise<QuotaSnapshot> {
  if (!apiKey) throw new Error('GLM Coding Plan credentials unavailable');
  // 该监控接口使用原始 API Key 作为 Authorization 值，与官方 glm-plan-usage 插件一致。
  const response = await fetch(GLM_USAGE_URL, {
    headers: { Authorization: apiKey, Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  return parseGlmQuota(await readQuotaResponse(response));
}
