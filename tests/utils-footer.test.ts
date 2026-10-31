import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLines, singleLine, type FooterView } from "../utils/footer.ts";

const view: FooterView = { model: "openai-codex/model", thinking: "high", cwd: join("/home", "user", "项目"), home: join("/home", "user"),
  branch: "main", contextPercent: 12.4, quota: "73%/1w/15h", statuses: ["其它扩展状态"] };
test("固定布局包含模型、思考、目录、分支、上下文、额度和其它扩展状态", () => {
  const lines = footerLines(view, 200);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /openai-codex\/model · high · 上下文 12%/);
  assert.ok(lines[0].includes(`~${join("/", "项目")}`));
  assert.match(lines[0], /main$/);
  assert.equal(lines[1], "额度 73%/1w/15h · 其它扩展状态");
  assert.match(footerLines({ ...view, contextPercent: null }, 200)[0], /上下文 —/);
});
test("任意窄宽度不越界，无状态时不占第二行，路径前缀不误替换", () => {
  for (const width of [0, 1, 2, 8, 20, 60, 120]) {
    assert.ok(footerLines(view, width).every(line => visibleWidth(line) <= width));
  }
  assert.equal(footerLines({ ...view, quota: undefined, statuses: [] }, 200).length, 1);
  assert.match(footerLines({ ...view, home: "/home/us" }, 200)[0], /user/);
});
test("路径和外部状态中的终端控制符不会进入状态栏", () => {
  assert.equal(singleLine("\x1b]0;unsafe\x07ok\n\x1b[31m红色\x1b[0m\u202e"), "ok 红色");
  assert.equal(singleLine("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"), "链接");
  const lines = footerLines({ ...view, branch: "main\nother", statuses: ["a\nb"] }, 200);
  assert.ok(lines.every(line => !/[\r\n\x1b]/.test(line)));
});
