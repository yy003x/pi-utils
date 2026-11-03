import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";
import { QUOTA_STATUS } from "../utils/quota/index.ts";

const view: FooterView = { model: "openai-codex/gpt-6-astra", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 24.8, contextWindow: 512000, quota: "73%/1w/15h", statuses: [] };
test("第一行原生路径和分支，第二行统计及靠右模型，不重复目录分支", () => {
  const lines = footerLines(view, 120);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "~/项目 (main)");
  assert.match(lines[1], /^24\.8%\/512K 73%\/1w\/15h +openai-codex\/gpt-6-astra high$/);
  assert.equal(visibleWidth(lines[1]), 120);
  assert.doesNotMatch(lines[1], /项目|main|额度/);
  assert.match(footerLines({ ...view, contextPercent: null }, 120)[1], /—\/512K/);
  const sample = footerLines({ ...view, cwd: "/Users/yang/.pi/agent/git/github.com/yy003x/pi-utils", home: "/Users/yang",
    contextPercent: 29, quota: "85%/1w/166h",
    run: { durationMs: 1_186_000, toolCalls: 8, turns: 4, status: "running",
      usage: { input: 100_000, output: 5600, cacheRead: 15_000, cacheWrite: 5000 } },
  }, 160);
  assert.equal(sample[0], "~/.pi/agent/git/github.com/yy003x/pi-utils (main)");
  assert.match(sample[1], /^29\.0%\/512K 85%\/1w\/166h tools:8 token:126K turn:4 running:19m46s +openai-codex\/gpt-6-astra high$/);
  assert.equal(visibleWidth(sample[1]), 160);
});
const colors = { dim: "\x1b[90m", warning: "\x1b[33m", error: "\x1b[31m" };
const theme = { fg: (color: string, text: string) => `${colors[color as keyof typeof colors]}${text}\x1b[39m` };

test("上下文按原生严格阈值着色，仅改变第二行上下文字段", () => {
  for (const [percent, color] of [
    [undefined, "dim"], [null, "dim"], [0, "dim"], [70, "dim"],
    [70.01, "warning"], [90, "warning"], [90.01, "error"], [100, "error"],
  ] as const) {
    const input = { ...view, contextPercent: percent, statuses: [["other", "external"]] as const };
    const lines = footerLines(input, 120, theme);
    const context = `${percent == null ? "—" : `${percent.toFixed(1)}%`}/512K`;
    assert.equal(lines[0], theme.fg("dim", "~/项目 (main)"));
    assert.ok(lines[1].includes(theme.fg(color, context)));
    assert.ok(lines[1].includes(theme.fg("dim", view.quota!)));
    assert.ok(lines[1].endsWith(theme.fg("dim", `${view.model} ${view.thinking}`)));
    assert.equal(lines[2], theme.fg("dim", "external"));
    assert.deepEqual(lines.map(singleLine), footerLines(input, 120).map(singleLine));
    const alerts = lines.join("").match(/\x1b\[(?:31|33)m/g) ?? [];
    assert.equal(alerts.length, color === "dim" ? 0 : 1);
  }
});

test("彩色上下文裁剪不改变列宽、布局或外部文本清理", () => {
  for (const percent of [70, 80, 95]) {
    const input = { ...view, contextPercent: percent, branch: "\x1b[31mmain\x1b[0m",
      statuses: [["other", "\x1b[31m外部状态\x1b[0m"]] as const };
    for (let width = 0; width <= 160; width++) {
      const lines = footerLines(input, width, theme);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.deepEqual(lines.map(singleLine), footerLines(input, width).map(singleLine));
      // 剩余转义序列必须都是完整的 SGR 颜色或重置序列。
      assert.ok(lines.every(line => !line.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b")));
    }
    const lines = footerLines(input, 160, theme);
    assert.equal(lines[0], theme.fg("dim", "~/项目 (main)"));
    assert.equal(lines[2], theme.fg("dim", "外部状态"));
  }
});

test("review、Hermes、subagent 及其它扩展状态全部集中在第三行", () => {
  const review = "⠸ review · 全局方案与单一执行 · 视角 1 (openai-codex/gpt-6-astra) ·";
  const statuses = [
    ["pi-review", review], ["hermes", "Hermes：partial"], ["other", "其它扩展状态"],
    ["subagent-diagnostics", "diagnostic"], ["subagent-slash", "running..."],
    ["subagent-slash-text", "tools 2"], ["subagents-edit", "waiting"],
    [QUOTA_STATUS, "不可重复的额度状态"],
  ] as const;
  const lines = footerLines({ ...view, statuses }, 240);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2), footerLines(view, 240));
  assert.equal(lines[2], `Hermes：partial 其它扩展状态 ${review} diagnostic running... tools 2 waiting`);
  assert.doesNotMatch(lines.join("\n"), /不可重复/);
  const narrow = footerLines({ ...view, statuses }, 20);
  assert.equal(narrow.length, 3);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  assert.match(narrow[2], /^Hermes：partial/);
});
test("没有其它扩展状态时不占第三行，未知扩展键也不进入前两行", () => {
  for (const statuses of [[], [["hermes", ""]], [["pi-review", " \n\t"]], [[QUOTA_STATUS, "73%/1w/15h"]]] as const) {
    assert.equal(footerLines({ ...view, statuses }, 120).length, 2);
  }
  assert.equal(footerLines({ ...view, statuses: [["new-extension", "external"]] }, 120)[2], "external");
});
test("窄宽度保留第二行右侧模型，最多三行且每行不越界", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 80, 120]) {
    for (const statuses of [view.statuses, [["pi-review", "review"], ["hermes", "Hermes：partial"]]] as const) {
      const lines = footerLines({ ...view, statuses }, width);
      assert.equal(lines.length, width < 1 ? 0 : statuses.length ? 3 : 2);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  }
  assert.match(footerLines(view, 60)[1], /openai-codex\/gpt-6-astra high$/);
  assert.equal(footerLines({ ...view, quota: undefined }, 200).length, 2);
  assert.match(footerLines({ ...view, contextWindow: undefined }, 200)[1], /24\.8%\/—/);
});
test("路径沿用原生规则：家目录缩写、边界判断、完整路径和可选括号分支", () => {
  for (const [cwd, home, expected] of [
    ["/work/pi-utils/", view.home, "/work/pi-utils/"],
    ["/work/pi-utils/../项目", view.home, "/work/pi-utils/../项目"],
    [view.home, view.home, "~"],
    ["/home/user/项目/../repo", view.home, "~/repo"],
    ["/home/user-other/repo", view.home, "/home/user-other/repo"],
    ["/home/user", "/home/user/child", "/home/user"],
    ["/", view.home, "/"],
    ["/work/repo", "", "/work/repo"],
  ]) {
    for (const branch of ["main", "feature/layout", undefined, null, ""]) {
      assert.equal(footerLines({ ...view, cwd, home, branch }, 120)[0], expected + (branch ? ` (${branch})` : ""));
    }
  }
});
test("扩展重新发布状态时出现第三行，清空后恢复两行", () => {
  const statuses = new Map<string, string>();
  const render = () => footerLines({ ...view, statuses: [...statuses] }, 120);
  assert.equal(render().length, 2);
  statuses.set("pi-review", "review");
  assert.equal(render()[2], "review");
  statuses.set("hermes", "Hermes：partial");
  assert.equal(render()[2], "Hermes：partial review");
  statuses.clear();
  assert.equal(render().length, 2);
  statuses.set("subagent-slash", "running...");
  assert.equal(render()[2], "running...");
});
test("路径和外部状态中的终端控制符不会进入状态栏", () => {
  assert.equal(singleLine("\x1b]0;unsafe\x07ok\n\x1b[31m红色\x1b[0m\u202e"), "ok 红色");
  assert.equal(singleLine("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"), "链接");
  const lines = footerLines({ ...view, cwd: "/work/\x1b[31m项目\x1b[0m", branch: "main\nother", statuses: [["hermes", "a\nb"]] }, 200);
  assert.ok(lines.every(line => !/[\r\n\x1b]/.test(line)));
  assert.equal(lines[0], "/work/项目 (main other)");
});
