import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCdSession, getCdArgumentCompletions, resolveCdTarget } from "../cd-command.ts";

test("目录解析与补全支持相对、绝对、家目录、空格和非法路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-utils-cd-path-"));
  try {
    const home = join(root, "home");
    mkdirSync(home); mkdirSync(join(root, "child")); mkdirSync(join(root, "My Folder"));
    writeFileSync(join(root, "file.txt"), "not a directory");
    assert.equal(resolveCdTarget("", root, home), null);
    assert.deepEqual(resolveCdTarget("child", root, home), { path: join(root, "child") });
    assert.deepEqual(resolveCdTarget('"My Folder"', root, home), { path: join(root, "My Folder") });
    assert.deepEqual(resolveCdTarget("~", root, home), { path: home });
    assert.deepEqual(resolveCdTarget(home, root), { path: home });
    assert.deepEqual(resolveCdTarget("file.txt", root), { error: `Not a directory: ${join(root, "file.txt")}` });
    assert.deepEqual(resolveCdTarget("missing", root), { error: `Directory does not exist: ${join(root, "missing")}` });
    const completions = getCdArgumentCompletions("", root, home);
    assert.ok(completions.some(item => item.label === "child/"));
    assert.ok(completions.some(item => item.label === "My Folder/"));
    assert.ok(!completions.some(item => item.label === "file.txt"));
    if (process.platform !== "win32") {
      assert.deepEqual(resolveCdTarget("My\\ Folder", root), { path: join(root, "My Folder") });
      assert.ok(getCdArgumentCompletions(parse(root).root, root).length > 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("真实会话分叉保留原始历史和源文件；新会话可切换，--no-session 不变为持久化", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-utils-cd-session-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const target = join(root, "target"); mkdirSync(target);
    const source = SessionManager.create(root, join(root, "sessions"));
    source.appendMessage({ role: "user", content: "目录切换测试数据", timestamp: 1 });
    assert.ok(existsSync(source.getSessionFile()!));
    const before = readFileSync(source.getSessionFile()!, "utf8");
    const result = createCdSession(source, target);
    const next = SessionManager.open(result);
    assert.equal(next.getCwd(), target);
    assert.deepEqual(next.getBranch(), source.getBranch());
    assert.notEqual(next.getSessionId(), source.getSessionId());
    assert.equal(next.getHeader()?.parentSession, source.getSessionFile());
    assert.equal(readFileSync(source.getSessionFile()!, "utf8"), before);
    const selectedLeaf = source.getLeafId()!;
    source.appendMessage({ role: "user", content: "已放弃的分支", timestamp: 2 });
    const diskBeforeBranch = readFileSync(source.getSessionFile()!, "utf8");
    source.branch(selectedLeaf);
    const selected = SessionManager.open(createCdSession(source, target));
    assert.deepEqual(selected.buildSessionProjection().messages, source.buildSessionProjection().messages);
    assert.deepEqual(selected.getEntries().slice(0, -1), source.getEntries());
    assert.equal(selected.getLeafEntry()?.type, "custom");
    source.resetLeaf();
    const emptyBranch = SessionManager.open(createCdSession(source, target));
    assert.deepEqual(emptyBranch.buildSessionProjection().messages, []);
    assert.equal(readFileSync(source.getSessionFile()!, "utf8"), diskBeforeBranch);
    const fresh = SessionManager.create(root, join(root, "fresh-sessions"));
    fresh.appendModelChange("test", "test");
    assert.equal(existsSync(fresh.getSessionFile()!), false);
    const freshNext = SessionManager.open(createCdSession(fresh, target));
    assert.deepEqual(freshNext.getEntries(), fresh.getEntries());
    assert.equal(freshNext.getCwd(), target);
    assert.equal(existsSync(fresh.getSessionFile()!), false);
    assert.throws(() => createCdSession(SessionManager.inMemory(root), target), /--no-session/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
