import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 独立 HOME、认证目录和白名单环境；只执行本地命令，不发送模型提示。
if (process.platform !== "darwin") throw new Error("此检查使用 macOS /usr/bin/script；其它平台使用 npm test 的 SDK 检查。");
const repository = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "pi-utils-tui-"));
const agentDir = join(root, "agent"), sourceDir = join(root, "source"), targetDir = join(root, "target");
mkdirSync(agentDir); mkdirSync(sourceDir); mkdirSync(targetDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }));
const source = SessionManager.create(sourceDir, join(root, "source-sessions"));
source.appendMessage({ role: "user", content: "TUI 会话保留测试数据，不发送给模型", timestamp: 1 });
const sourceFile = source.getSessionFile();
let output = "";
// BSD script 不接受 Node socketpair stdin，使用系统管道。
const child = spawn("/bin/bash", ["-c", 'cat | "$@"', "pi-utils-tui", "/usr/bin/script", "-q", "/dev/null", process.execPath,
  join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "--offline", "--no-approve", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--session", sourceFile,
  "-e", join(repository, "utils/index.ts"),
], { cwd: sourceDir, detached: true, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TERM: "xterm-256color", LANG: "en_US.UTF-8", COLUMNS: "120", LINES: "40", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: "pipe" });
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });
const exit = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
async function waitFor(pattern, from = 0) {
  if (pattern.test(output.slice(from))) return;
  await new Promise((resolveWait, reject) => {
    const check = () => { if (pattern.test(output.slice(from))) finish(); };
    const timer = setTimeout(() => finish(new Error(`终端未出现 ${pattern}\n${output.slice(-5000)}`)), 15000);
    const finish = error => { clearTimeout(timer); child.stdout.off("data", check); error ? reject(error) : resolveWait(); };
    child.stdout.on("data", check);
    check();
  });
}
async function command(input, pattern) {
  const from = output.length;
  child.stdin.write(input + "\r");
  await waitFor(pattern, from);
}
try {
  await waitFor(/\(anthropic\) claude-sonnet-4-5 •/);
  await waitFor(/(?:\d+\.\d%|—)\/\d+k/);
  await command("/run-stats", /暂无运行统计/);
  await command("/cd missing", /Directory does not exist/);
  const sourceBefore = readFileSync(sourceFile, "utf8");
  await command(`/cd ${targetDir}`, /Resumed session/);
  await command("/cd", /\/target/);
  await command("/run-stats", /暂无运行统计/);
  await command("/reload", /Reloaded keybindings/);
  await command("/run-stats", /暂无运行统计/);
  child.stdin.end("/quit\r");
  const result = await Promise.race([exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("终端退出超时")), 8000); timer.unref();
  })]);
  assert.equal(result.code, 0);
  assert.doesNotMatch(output, /TypeError|ReferenceError|Failed to load extension|Extension error|Unknown model/);
  assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore);
  const sessionRoot = join(agentDir, "sessions");
  const sessions = readdirSync(sessionRoot, { recursive: true }).filter(path => path.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const target = SessionManager.open(join(sessionRoot, sessions[0]));
  assert.equal(target.getCwd(), targetDir);
  assert.equal(target.getHeader().parentSession, sourceFile);
  const originalMessages = SessionManager.open(sourceFile).getBranch().filter(entry => entry.type === "message");
  assert.deepEqual(target.getBranch().filter(entry => entry.type === "message"), originalMessages);
  assert.ok(!target.getEntries().some(entry => entry.type === "custom" || entry.type === "custom_message"));
  assert.equal(existsSync(join(agentDir, "pi-utils.json")), false);
  // Pi CLI 会初始化空认证文件；验证其中没有任何账户，而非假定它不创建文件。
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")), {});
  console.log("真实 TUI 通过：固定底栏、只读命令、无效目录、/cd 会话替换与历史保留、重载、退出。未调用模型或修改个人 Pi 配置。");
} finally {
  if (child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  await exit;
  rmSync(root, { recursive: true, force: true });
}
