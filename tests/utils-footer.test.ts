import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";

const view: FooterView = { model: "(openai-codex) gpt-6-sol", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 24.8, contextWindow: 512000, quota: "73%/1w/15h", statuses: ["其它扩展状态"] };
test("单行左侧紧凑显示路径、分支、上下文和额度，模型靠右", () => {
  const lines = footerLines(view, 120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^~\/项目 main 24\.8%\/512k 73%\/1w\/15h 其它扩展状态 +\(openai-codex\) gpt-6-sol • high$/);
  assert.equal(visibleWidth(lines[0]), 120);
  assert.doesNotMatch(lines[0], /额度/);
  assert.match(footerLines({ ...view, contextPercent: null }, 120)[0], /—\/512k/);
  const ownStatus = footerLines({ ...view, cwd: "/work", statuses: [] }, 120)[0];
  assert.doesNotMatch(ownStatus, /[\u3400-\u9fff]/);
  const sample = footerLines({ ...view, cwd: "/Users/yang/mycode/pi-utils", home: "/Users/yang",
    contextPercent: 29, quota: "85%/1w/166h", statuses: [] }, 120)[0];
  assert.match(sample, /^~\/mycode\/pi-utils main 29\.0%\/512k 85%\/1w\/166h +\(openai-codex\) gpt-6-sol • high$/);
});
test("窄宽度保留右侧模型且只占一行，路径前缀不误替换", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 80, 120]) {
    const lines = footerLines(view, width);
    assert.ok(lines.length <= 1);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.match(footerLines(view, 60)[0], /\(openai-codex\) gpt-6-sol • high$/);
  assert.equal(footerLines({ ...view, quota: undefined, statuses: [] }, 200).length, 1);
  assert.match(footerLines({ ...view, home: "/home/us" }, 200)[0], /user/);
  assert.match(footerLines({ ...view, contextWindow: undefined }, 200)[0], /24\.8%\/—/);
});
test("路径和外部状态中的终端控制符不会进入状态栏", () => {
  assert.equal(singleLine("\x1b]0;unsafe\x07ok\n\x1b[31m红色\x1b[0m\u202e"), "ok 红色");
  assert.equal(singleLine("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"), "链接");
  const lines = footerLines({ ...view, branch: "main\nother", statuses: ["a\nb"] }, 200);
  assert.ok(lines.every(line => !/[\r\n\x1b]/.test(line)));
});
