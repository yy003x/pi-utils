import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";

const view: FooterView = { model: "(openai-codex) gpt-6-sol", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 24.8, contextWindow: 512000, quota: "73%/1w/15h", statuses: [["other", "其它扩展状态"]] };
test("主行左侧紧凑显示项目名、分支、上下文和额度，模型靠右", () => {
  const lines = footerLines(view, 120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^项目 main 24\.8%\/512k 73%\/1w\/15h 其它扩展状态 +\(openai-codex\) gpt-6-sol • high$/);
  assert.equal(visibleWidth(lines[0]), 120);
  assert.doesNotMatch(lines[0], /额度/);
  assert.match(footerLines({ ...view, contextPercent: null }, 120)[0], /—\/512k/);
  const ownStatus = footerLines({ ...view, cwd: "/work", statuses: [] }, 120)[0];
  assert.doesNotMatch(ownStatus, /[\u3400-\u9fff]/);
  const sample = footerLines({ ...view, cwd: "/Users/yang/.pi/agent/git/github.com/yy003x/pi-utils", home: "/Users/yang",
    contextPercent: 29, quota: "85%/1w/166h", statuses: [] }, 120)[0];
  assert.match(sample, /^pi-utils main 29\.0%\/512k 85%\/1w\/166h +\(openai-codex\) gpt-6-sol • high$/);
});
test("Hermes 和 pi-subagents 状态仅在存在时合并到第二行", () => {
  const statuses = [
    ["other", "其它扩展状态"], ["hermes", "Hermes：failed"],
    ["subagent-diagnostics", "diagnostic"], ["subagent-slash", "running..."],
    ["subagent-slash-text", "tools 2"], ["subagents-edit", "waiting"],
    ["model-quota", "不可重复的额度状态"],
  ] as const;
  const lines = footerLines({ ...view, statuses }, 120);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /其它扩展状态 +\(openai-codex\) gpt-6-sol • high$/);
  assert.doesNotMatch(lines[0], /Hermes|diagnostic|running|tools 2|waiting|不可重复/);
  assert.equal(lines[1], "Hermes：failed diagnostic running... tools 2 waiting");
  assert.equal(footerLines({ ...view, statuses: [["hermes", ""]] }, 120).length, 1);
  const narrow = footerLines({ ...view, statuses }, 20);
  assert.equal(narrow.length, 2);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
});
test("窄宽度保留右侧模型且只占一行", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 80, 120]) {
    const lines = footerLines(view, width);
    assert.ok(lines.length <= 1);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.match(footerLines(view, 60)[0], /\(openai-codex\) gpt-6-sol • high$/);
  assert.equal(footerLines({ ...view, quota: undefined, statuses: [] }, 200).length, 1);
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
  statuses.set("hermes", "Hermes：failed");
  assert.equal(render()[1], "Hermes：failed");
  statuses.set("subagent-slash", "running...");
  assert.equal(render()[1], "Hermes：failed running...");
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
