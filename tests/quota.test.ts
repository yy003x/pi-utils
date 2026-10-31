import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_USAGE_URL, GLM_USAGE_URL, STALE_MS, formatQuota, fetchCodexQuota, fetchGlmQuota,
  isChatGPTSubscription, isCodexSubscription, isGlmCodingPlan, parseCodexQuota, parseGlmQuota,
} from '../utils/quota/core.ts';

const official = {
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
};

test('官方新版 Responses OAuth 渠道显示订阅标识', () => {
  assert.equal(isChatGPTSubscription(official, true), true);
  assert.equal(isChatGPTSubscription({ ...official, baseUrl: `${official.baseUrl}/` }, true), true);
});

test('API Key、无模型和其他 provider 不显示 ChatGPT 订阅标识', () => {
  assert.equal(isChatGPTSubscription(official, false), false);
  assert.equal(isChatGPTSubscription(undefined, true), false);
  assert.equal(isChatGPTSubscription({ ...official, provider: 'anthropic' }, true), false);
});

test('不混用 provider 与协议', () => {
  assert.equal(isChatGPTSubscription({ ...official, provider: 'openai-codex' }, true), false);
  assert.equal(isChatGPTSubscription({ ...official, api: 'openai-completions' }, true), false);
});

test('同名代理、不同路径与非法地址不冒充官方订阅渠道', () => {
  for (const baseUrl of [
    'https://proxy.example/v1', 'http://api.openai.com/v1',
    'https://api.openai.com:8443/v1', 'https://api.openai.com/other',
    'https://api.openai.com/v1?route=other', 'https://api.openai.com/v1#other',
    'https://user@api.openai.com/v1', 'not-a-url', '',
  ]) {
    assert.equal(isChatGPTSubscription({ ...official, baseUrl }, true), false, baseUrl);
  }
});

test('用量入口与查询地址固定为官方 HTTPS 地址', () => {
  assert.equal(CODEX_USAGE_URL, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(GLM_USAGE_URL, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
});

const codex = {
  provider: 'openai-codex',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
};

test('Codex OAuth 与新版订阅独立识别，不借用新版认证查询 Codex', () => {
  assert.equal(isCodexSubscription(codex, true), true);
  assert.equal(isChatGPTSubscription(codex, true), true);
  assert.equal(isCodexSubscription({ ...codex, baseUrl: `${codex.baseUrl}/` }, true), true);
  assert.equal(isCodexSubscription(codex, false), false);
  assert.equal(isCodexSubscription(official, true), false);
  assert.equal(isCodexSubscription({ ...codex, api: 'openai-responses' }, true), false);
  assert.equal(isCodexSubscription({ ...codex, provider: 'openai' }, true), false);
  for (const baseUrl of [
    'https://proxy.example/backend-api', 'http://chatgpt.com/backend-api',
    'https://chatgpt.com:8443/backend-api', 'https://chatgpt.com/backend-api/codex',
    'https://chatgpt.com/backend-api?x=1', 'https://user@chatgpt.com/backend-api',
    'https://chatgpt.com/backend-api#x', 'not-a-url', '',
  ]) assert.equal(isCodexSubscription({ ...codex, baseUrl }, true), false, baseUrl);
});

// 纯函数输入只验证格式和计算，不作为远端账号或请求的替代实现。
const now = 1_790_000_000_000;
const window = (used: unknown, seconds = 604800) => ({
  used_percent: used, limit_window_seconds: seconds, reset_at: now / 1000 + 600,
});
const payload = (primary: unknown, secondary: unknown = null) => ({
  rate_limit: { primary_window: primary, secondary_window: secondary },
});

test('按服务端的单个 7 天窗口显示剩余额度，不假定存在 5 小时窗口', () => {
  const snapshot = parseCodexQuota(payload(window(27)), now);
  assert.equal(formatQuota(snapshot, now), '73%/1w/1h');
  assert.equal(snapshot.windows[0].resetAt, now + 600_000);
  assert.equal(snapshot.fetchedAt, now);
});

test('双窗口、零余额与超过额度均正确，主窗口不存在时保留次窗口', () => {
  assert.equal(formatQuota(parseCodexQuota(payload(window(100, 18000), window(0)), now), now),
    '0%/5h/1h · 100%/1w/1h');
  assert.equal(formatQuota(parseCodexQuota(payload(null, window(105)), now), now), '0%/1w/1h');
  assert.equal(formatQuota(parseCodexQuota(payload(window(27.1)), now), now), '72.9%/1w/1h');
});

test('缺失、非数字与畸形字段不得伪造为 100% 剩余', () => {
  for (const value of [null, {}, [], { rate_limit: null }, payload(null), payload('invalid'),
    payload(window('27')), payload(window(-1)), payload(window(NaN)), payload(window(Infinity)),
    payload({ ...window(27), reset_at: 0 }), payload({ ...window(27), limit_window_seconds: -1 }),
  ]) assert.throws(() => parseCodexQuota(value, now));
});

test('到达重置时间或快照过期后不推算额度恢复', () => {
  const snapshot = parseCodexQuota(payload(window(27)), now);
  assert.equal(formatQuota(snapshot, now + STALE_MS), 'stale/1w/1h');
  const atReset = { ...snapshot, fetchedAt: now + 600_000 };
  assert.equal(formatQuota(atReset, now + 600_000), 'stale/1w/0h');
});

test('紧凑格式显示周期和距重置小时数，不把不足一小时显示为零', () => {
  const snapshot = parseCodexQuota(payload({ ...window(27), reset_at: now / 1000 + 15 * 3600 }), now);
  assert.equal(formatQuota(snapshot, now), '73%/1w/15h');
  assert.equal(formatQuota(snapshot, now + 1), '73%/1w/15h');
  const twoDays = parseCodexQuota(payload(window(27, 2 * 86400)), now);
  assert.equal(formatQuota(twoDays, now), '73%/2d/1h');
  const minutes = parseCodexQuota(payload(window(27, 90)), now);
  assert.equal(formatQuota(minutes, now), '73%/2m/1h');
});

const glm = {
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
};

const glmLimit = (over: Partial<Record<string, unknown>>) => ({
  type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 235,
  remaining: 27765, percentage: 1, nextResetTime: now + 9_000_000, ...over,
});
const weekly = {
  type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 371,
  remaining: 139629, percentage: 1, nextResetTime: now + 166 * 3_600_000,
};

test('GLM Coding Plan 官方路由识别，代理与其他 provider 不冒充', () => {
  assert.equal(isGlmCodingPlan(glm), true);
  assert.equal(isGlmCodingPlan({ ...glm, baseUrl: `${glm.baseUrl}/` }), true);
  assert.equal(isGlmCodingPlan({ ...glm, provider: 'zai' }), false);
  assert.equal(isGlmCodingPlan({ ...glm, api: 'anthropic-messages' }), false);
  for (const baseUrl of [
    'https://proxy.example/api/coding/paas/v4', 'http://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4?x=1',
    'https://user@open.bigmodel.cn/api/coding/paas/v4', 'not-a-url', '',
  ]) assert.equal(isGlmCodingPlan({ ...glm, baseUrl }), false, baseUrl);
});

test('GLM 双窗口按剩余比例显示 5h 与 7d，顺序按重置时间', () => {
  const snapshot = parseGlmQuota({ code: 200, success: true, data: { limits: [weekly, glmLimit({})] } }, now);
  assert.equal(formatQuota(snapshot, now), '99.2%/5h/3h · 99.7%/7d/166h');
  assert.deepEqual(snapshot.windows.map(window => window.label), ['5h', '7d']);
});

test('GLM 缺失、单位未知和数值不一致的窗口不得伪造额度', () => {
  const cases: unknown[] = [
    null, {}, { code: 200, data: {} }, { data: { limits: [] } },
    { data: { limits: [{ type: 'TIME_LIMIT' }] } },
    { data: { limits: [glmLimit({ unit: 5 })] } },
    { data: { limits: [glmLimit({ unit: 'toString' })] } },
    { data: { limits: [glmLimit({ number: 0 })] } },
    { data: { limits: [glmLimit({ usage: 0 })] } },
    { data: { limits: [glmLimit({ remaining: -1 })] } },
    { data: { limits: [glmLimit({ remaining: 28001 })] } },
    { data: { limits: [glmLimit({ nextResetTime: 0 })] } },
    { data: { limits: [glmLimit({ remaining: '27765' })] } },
  ];
  for (const value of cases) assert.throws(() => parseGlmQuota(value, now));
});

test('GLM 快照过期后不推算恢复，且不保存套餐与账户信息', () => {
  const snapshot = parseGlmQuota({
    code: 200, msg: '操作成功',
    data: { level: 'max', limits: [glmLimit({}), weekly] },
  }, now);
  assert.equal(formatQuota(snapshot, now + STALE_MS), 'stale/5h/3h · stale/7d/166h');
  assert.equal(JSON.stringify(snapshot).includes('max'), false);
});

test('无效或空认证在请求前失败，不调用远端额度接口', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(fetchCodexQuota('invalid', signal), /Invalid Codex login credentials/);
  await assert.rejects(fetchGlmQuota('', signal), /credentials unavailable/);
});

test('解析结果不保存服务端个人信息和凭据', () => {
  const snapshot = parseCodexQuota({ ...payload(window(27)), email: 'private', account_id: 'private' }, now);
  assert.deepEqual(Object.keys(snapshot), ['windows', 'fetchedAt']);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
});
