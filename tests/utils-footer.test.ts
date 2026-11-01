import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";
import { QUOTA_STATUS } from "../utils/quota/index.ts";

const view: FooterView = { model: "openai-codex/gpt-6-astra", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 24.8, contextWindow: 512000, quota: "73%/1w/15h", statuses: [] };
test("主行只显示定义的字段，模型和思考级别靠右", () => {
  const lines = footerLines(view, 120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^项目 main 24\.8%\/512K 73%\/1w\/15h +openai-codex\/gpt-6-astra high$/);
  assert.equal(visibleWidth(lines[0]), 120);
  assert.doesNotMatch(lines[0], /额度/);
  assert.match(footerLines({ ...view, contextPercent: null }, 120)[0], /—\/512K/);
  const sample = footerLines({ ...view, cwd: "/Users/yang/.pi/agent/git/github.com/yy003x/pi-utils", home: "/Users/yang",
    contextPercent: 29, quota: "85%/1w/166h",
    run: { durationMs: 1_186_000, toolCalls: 8, turns: 4, status: "running",
      usage: { input: 100_000, output: 5600, cacheRead: 15_000, cacheWrite: 5000 } },
  }, 160)[0];
  assert.match(sample, /^pi-utils main 29\.0%\/512K 85%\/1w\/166h tools:8 token:126K turn:4 running:19m46s +openai-codex\/gpt-6-astra high$/);
  assert.equal(visibleWidth(sample), 160);
});
test("review、Hermes、subagent 及其它扩展状态全部集中在第二行", () => {
  const review = "⠸ review · 全局方案与单一执行 · 视角 1 (openai-codex/gpt-6-astra) ·";
  const statuses = [
    ["pi-review", review], ["hermes", "Hermes：partial"], ["other", "其它扩展状态"],
    ["subagent-diagnostics", "diagnostic"], ["subagent-slash", "running..."],
    ["subagent-slash-text", "tools 2"], ["subagents-edit", "waiting"],
    [QUOTA_STATUS, "不可重复的额度状态"],
  ] as const;
  const lines = footerLines({ ...view, statuses }, 240);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], footerLines(view, 240)[0]);
  assert.equal(lines[1], `Hermes：partial 其它扩展状态 ${review} diagnostic running... tools 2 waiting`);
  assert.doesNotMatch(lines.join("\n"), /不可重复/);
  const narrow = footerLines({ ...view, statuses }, 20);
  assert.equal(narrow.length, 2);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  assert.match(narrow[1], /^Hermes：partial/);
});
test("没有其它扩展状态时不占第二行，未知扩展键也不进入主行", () => {
  for (const statuses of [[], [["hermes", ""]], [["pi-review", " \n\t"]], [[QUOTA_STATUS, "73%/1w/15h"]]] as const) {
    assert.equal(footerLines({ ...view, statuses }, 120).length, 1);
  }
  assert.equal(footerLines({ ...view, statuses: [["new-extension", "external"]] }, 120)[1], "external");
});
test("窄宽度保留右侧模型，最多两行且每行不越界", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 80, 120]) {
    for (const statuses of [view.statuses, [["pi-review", "review"], ["hermes", "Hermes：partial"]]] as const) {
      const lines = footerLines({ ...view, statuses }, width);
      assert.equal(lines.length, width < 1 ? 0 : statuses.length ? 2 : 1);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  }
  assert.match(footerLines(view, 60)[0], /openai-codex\/gpt-6-astra high$/);
  assert.equal(footerLines({ ...view, quota: undefined }, 200).length, 1);
  assert.match(footerLines({ ...view, home: "/home/us" }, 200)[0], /^项目 /);
  assert.match(footerLines({ ...view, contextWindow: undefined }, 200)[0], /24\.8%\/—/);
});
test("目录仅显示最后一级，主目录和根目录保留可辨识名称", () => {
  for (const [cwd, expected] of [
    ["/work/pi-utils/", "pi-utils"], ["/work/pi-utils/../项目", "项目"],
    [view.home, "~"], ["/", "/"],
  ]) {
    assert.ok(footerLines({ ...view, cwd }, 120)[0].startsWith(expected + " "));
  }
});
test("扩展重新发布状态时出现第二行，清空后恢复主行", () => {
  const statuses = new Map<string, string>();
  const render = () => footerLines({ ...view, statuses: [...statuses] }, 120);
  assert.equal(render().length, 1);
  statuses.set("pi-review", "review");
  assert.equal(render()[1], "review");
  statuses.set("hermes", "Hermes：partial");
  assert.equal(render()[1], "Hermes：partial review");
  statuses.clear();
  assert.equal(render().length, 1);
  statuses.set("subagent-slash", "running...");
  assert.equal(render()[1], "running...");
});
test("路径和外部状态中的终端控制符不会进入状态栏", () => {
  assert.equal(singleLine("\x1b]0;unsafe\x07ok\n\x1b[31m红色\x1b[0m\u202e"), "ok 红色");
  assert.equal(singleLine("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"), "链接");
  const lines = footerLines({ ...view, branch: "main\nother", statuses: [["hermes", "a\nb"]] }, 200);
  assert.ok(lines.every(line => !/[\r\n\x1b]/.test(line)));
});
