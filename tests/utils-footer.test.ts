import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";

const view: FooterView = { model: "(openai-codex) gpt-6-sol", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 24.8, contextWindow: 512000, quota: "73%/1w/15h", statuses: ["其它扩展状态"] };
test("单行显示额度数值和其它状态，不显示中文额度标签", () => {
  const lines = footerLines(view, 200);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\(openai-codex\) gpt-6-sol • high {3}24\.8%\/512k {3}73%\/1w\/15h/);
  assert.ok(lines[0].includes(`~${join("/", "项目")}`));
  assert.match(lines[0], /main {3}其它扩展状态$/);
  assert.doesNotMatch(lines[0], /额度/);
  assert.match(footerLines({ ...view, contextPercent: null }, 200)[0], /—\/512k/);
  const ownStatus = footerLines({ ...view, cwd: "/work", statuses: [] }, 200)[0];
  assert.doesNotMatch(ownStatus, /[\u3400-\u9fff]/);
});
test("任意窄宽度只渲染一行且不越界，路径前缀不误替换", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 120]) {
    const lines = footerLines(view, width);
    assert.ok(lines.length <= 1);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.equal(footerLines({ ...view, quota: undefined, statuses: [] }, 200).length, 1);
  assert.match(footerLines({ ...view, cwd: "/work", statuses: [] }, 60)[0], /73%\/1w\/15h/);
  assert.match(footerLines({ ...view, home: "/home/us" }, 200)[0], /user/);
  assert.match(footerLines({ ...view, contextWindow: undefined }, 200)[0], /24\.8%\/—/);
});
test("路径和外部状态中的终端控制符不会进入状态栏", () => {
  assert.equal(singleLine("\x1b]0;unsafe\x07ok\n\x1b[31m红色\x1b[0m\u202e"), "ok 红色");
  assert.equal(singleLine("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"), "链接");
  const lines = footerLines({ ...view, branch: "main\nother", statuses: ["a\nb"] }, 200);
  assert.ok(lines.every(line => !/[\r\n\x1b]/.test(line)));
});
