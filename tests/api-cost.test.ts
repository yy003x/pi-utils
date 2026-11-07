import test from "node:test";
import assert from "node:assert/strict";
import { COSTS_URL, costPeriods, costsUrl, formatCosts, isOpenAICostRoute, matchesKey, parseCostsPage, parseKeyList, uniqueKeyId } from "../utils/api-cost/core.ts";

const now = Date.parse("2026-03-31T12:34:56Z");
const auth = {
  chatgpt_plan_type: "pro",
  chatgpt_subscription_active_start: "2026-03-15T08:00:00Z",
  chatgpt_subscription_active_until: "2026-04-15T08:00:00Z",
};
// 纯解析输入，不是认证凭据，不用于任何网络请求。
function token(claims: unknown, exp = now / 1000 + 3600): string {
  return `header.${Buffer.from(JSON.stringify({ exp, iat: 1, "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
}

const keyId = "key_test";
function row(value: unknown = 0.1234, id: unknown = keyId, currency = "usd") {
  return { object: "organization.costs.result", api_key_id: id, amount: { value, currency } };
}
function page(results: unknown[] = [], more = false, next: unknown = null) {
  return { object: "page", data: [{ results }], has_more: more, next_page: next };
}

test("只接受当前官方 openai 路由，Codex、其他Provider与同名代理不混用", () => {
  const model = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
  assert.equal(isOpenAICostRoute(model), true);
  assert.equal(isOpenAICostRoute({ ...model, baseUrl: `${model.baseUrl}/` }), true);
  assert.equal(isOpenAICostRoute(undefined), false);
  for (const provider of ["openai-codex", "anthropic", "custom"]) {
    assert.equal(isOpenAICostRoute({ ...model, provider }), false);
  }
  for (const baseUrl of ["https://proxy.example/v1", "https://api.openai.com/v1?x=y", "https://api.openai.com:8080/v1", "https://user@api.openai.com/v1", "https://api.openai.com/v1/other"]) {
    assert.equal(isOpenAICostRoute({ ...model, baseUrl }), false);
  }
});

test("通过当前密钥的脱敏前后缀匹配ID，缺失或多个匹配拒绝猜测", () => {
  const value = "sk-proj-example-middle-abcd";
  for (const redacted of [value, "sk-proj-...abcd", "sk-proj-…abcd", "sk-proj-****abcd"]) {
    assert.equal(matchesKey(value, redacted), true);
  }
  for (const redacted of [null, "", "sk-...xyz", "sk-...wxyz", "...abcd", "sk-...", "sk-...mid...abcd"]) {
    assert.equal(matchesKey(value, redacted), false);
  }
  assert.equal(uniqueKeyId([keyId]), keyId);
  for (const ids of [[], [keyId, "key_other"], [keyId, keyId], ["sk-secret"], [""], ["key_1,key_2"]]) {
    assert.throws(() => uniqueKeyId(ids));
  }
});

test("项目和Key元数据分页要求完整契约，不截断列表", () => {
  assert.deepEqual(parseKeyList({ data: [{ id: "proj_example" }], has_more: true, last_id: "cursor" }), {
    data: [{ id: "proj_example" }], next: "cursor",
  });
  assert.deepEqual(parseKeyList({ data: [], has_more: false }), { data: [], next: undefined });
  for (const input of [undefined, {}, { data: [null], has_more: false }, { data: [], has_more: true },
    { data: [{ id: 123 }], has_more: false }, { data: [], has_more: true, last_id: "" }]) {
    assert.throws(() => parseKeyList(input));
  }
});

test("订阅起点取声明值，不把令牌签发日或额度重置日当订阅起点", () => {
  const selected = costPeriods(token(auth), now);
  assert.equal(selected.reason, undefined);
  assert.deepEqual(selected.periods, [{ label: "订阅起点至今", start: Date.parse(auth.chatgpt_subscription_active_start) / 1000, end: now / 1000 }]);
  const absent = costPeriods(token({ chatgpt_plan_type: "pro", reset_at: now / 1000 + 100 }), now);
  assert.match(absent.reason!, /缺少有效订阅起止日期/);
  assert.equal(absent.periods.length, 2);
});

test("订阅失效、free、日期缺失、未来起点及坏令牌均明确回退", () => {
  for (const claims of [
    { ...auth, chatgpt_subscription_active_until: "2026-03-31T12:34:56Z" },
    { ...auth, chatgpt_plan_type: "free" },
    { ...auth, chatgpt_subscription_active_start: "2026-04-01T00:00:00Z" },
    { ...auth, chatgpt_subscription_active_start: "invalid" },
    { ...auth, chatgpt_subscription_active_start: "2026-03-15T08:00:00" },
    {},
  ]) {
    const selected = costPeriods(token(claims), now);
    assert.ok(selected.reason);
    assert.equal(selected.periods.length, 2);
  }
  assert.match(costPeriods(token(auth, now / 1000), now).reason!, /令牌已过期/);
  assert.match(costPeriods("invalid", now).reason!, /无法解析/);
  assert.equal(costPeriods(undefined, now, "认证失败").reason, "认证失败");
});

test("回退始终使用滚动7天和30天，月底、闰年和跨年不改成日历月", () => {
  for (const time of [now, Date.parse("2024-03-31T12:34:56Z"), Date.parse("2026-01-05T12:34:56Z")]) {
    const selected = costPeriods(undefined, time).periods;
    assert.deepEqual(selected.map(period => period.label), ["最近7天", "最近30天"]);
    assert.equal(selected[0].start, time / 1000 - 7 * 86400);
    assert.equal(selected[1].start, time / 1000 - 30 * 86400);
    assert.ok(selected.every(period => period.end === time / 1000));
  }
});

test("每一页始终使用官方URL及单Key筛选和分组，带起止时间", () => {
  const period = costPeriods(undefined, now).periods[0];
  for (const cursor of [undefined, "next/cursor?&"]) {
    const url = costsUrl(period, keyId, cursor);
    assert.equal(`${url.origin}${url.pathname}`, COSTS_URL);
    assert.deepEqual(url.searchParams.getAll("api_key_ids[]"), [keyId]);
    assert.equal(url.searchParams.get("group_by[]"), "api_key_id");
    assert.equal(url.searchParams.get("start_time"), String(period.start));
    assert.equal(url.searchParams.get("end_time"), String(Date.parse("2026-04-01T00:00:00Z") / 1000));
    assert.equal(url.searchParams.get("bucket_width"), "1d");
    assert.equal(url.searchParams.get("page"), cursor ?? null);
    assert.equal(url.searchParams.get("limit"), "180");
  }
  assert.throws(() => costsUrl(period, ""));
  assert.throws(() => costsUrl({ ...period, start: period.end }, keyId));
});

test("费用请求覆盖当天完整UTC日桶，跨月、跨年和零点不遗漏当前日期", () => {
  for (const [current, nextDay] of [
    ["2026-11-07T13:03:44Z", "2026-11-08T00:00:00Z"],
    ["2026-11-07T00:00:00Z", "2026-11-08T00:00:00Z"],
    ["2026-03-31T23:59:59Z", "2026-04-01T00:00:00Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z"],
    ["2024-02-29T12:00:00Z", "2024-03-01T00:00:00Z"],
    ["2026-11-08T01:00:00+08:00", "2026-11-08T00:00:00Z"],
  ]) {
    const time = Date.parse(current);
    const periods = costPeriods(undefined, time).periods;
    for (const period of periods) {
      const before = { ...period };
      const url = costsUrl(period, keyId);
      assert.equal(url.searchParams.get("end_time"), String(Date.parse(nextDay) / 1000));
      assert.equal(url.searchParams.get("start_time"), String(period.start));
      assert.deepEqual(period, before);
    }
    assert.equal(formatCosts(periods.map(period => ({ ...period, usd: 1 }))), "1.0000$/7d 1.0000$/30d");
  }
});

test("订阅费用也覆盖当天日桶，展示天数仍按查询时刻计算", () => {
  const time = Date.parse("2026-03-31T08:00:00Z");
  const period = costPeriods(token(auth), time).periods[0];
  assert.equal(costsUrl(period, keyId).searchParams.get("end_time"), String(Date.parse("2026-04-01T00:00:00Z") / 1000));
  assert.equal(period.end, time / 1000);
  assert.equal(formatCosts([{ ...period, usd: 1 }]), "1.0000$/16d");
});

test("费用解析保留小额和负数调整，空结果是零，后续分页不能遗漏", () => {
  assert.deepEqual(parseCostsPage(page([row(0.0001), row(-0.00005)]), keyId), { usd: 0.00005, next: undefined });
  assert.deepEqual(parseCostsPage(page(), keyId), { usd: 0, next: undefined });
  assert.deepEqual(parseCostsPage(page([row(1)], true, "cursor"), keyId), { usd: 1, next: "cursor" });
  assert.throws(() => parseCostsPage(page([], true), keyId), /分页/);
  assert.throws(() => parseCostsPage(page([], true, ""), keyId), /分页/);
});

test("拒绝组织合计、其他Key、异常金额、错误币种及坏响应，不显示部分费用", () => {
  for (const input of [page([row(10, null)]), page([row(10, "another_key")]), page([row(1), row(10, null)])]) {
    assert.throws(() => parseCostsPage(input, keyId), /指定 Key/);
  }
  for (const input of [undefined, {}, { ...page(), has_more: undefined }, { ...page(), data: [{}] },
    page([row(null)]), page([row("1")]), page([row(NaN)]), page([row(Infinity)]), page([row(1, keyId, "eur")])]) {
    assert.throws(() => parseCostsPage(input, keyId));
  }
});

test("费用只显示x$/7d x$/30d或单个订阅区间x$/Nd，不带时间和回退文案", () => {
  const fallback = costPeriods(undefined, now);
  assert.equal(formatCosts(fallback.periods.map(period => ({ ...period, usd: 0.0565945 }))), "0.0566$/7d 0.0566$/30d");
  const subscription = costPeriods(token(auth), now);
  assert.equal(subscription.periods.length, 1);
  assert.equal(formatCosts(subscription.periods.map(period => ({ ...period, usd: 1.23456 }))), "1.2346$/17d");
  const period = { label: "订阅起点至今", start: 100, end: 101, usd: 0 };
  assert.equal(formatCosts([period]), "0.0000$/1d");
  assert.equal(formatCosts([{ ...period, end: 100 + 86400, usd: -0.0123 }]), "-0.0123$/1d");
  assert.equal(formatCosts([{ ...period, end: 101 + 86400 }]), "0.0000$/2d");
});
