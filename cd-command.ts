import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function unescapePathArg(value: string): string {
  const path = stripMatchingQuotes(value);
  return process.platform === "win32" ? path : path.replace(/\\(.)/g, "$1");
}

function expandHomePath(value: string, homeDir = homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function escapeCompletionPath(value: string): string {
  return process.platform === "win32" ? `"${value}"` : value.replace(/([\\\s"'`$&|;<>()[\]{}?!*])/g, "\\$1");
}

function displayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function resolveCdTarget(args: string, cwd: string, homeDir = homedir()): { path: string } | { error: string } | null {
  const input = unescapePathArg(args);
  if (!input) return null;

  const expanded = expandHomePath(input, homeDir);
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);

  if (!existsSync(target)) {
    return { error: `Directory does not exist: ${target}` };
  }

  try {
    if (!statSync(target).isDirectory()) {
      return { error: `Not a directory: ${target}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Cannot access directory: ${message}` };
  }

  return { path: target };
}

function pathBase(token: string, cwd: string, homeDir: string): { dir: string; prefix: string; displayPrefix: string } {
  const input = unescapePathArg(token);
  const unescaped = process.platform === "win32" ? input.replace(/\\/g, "/") : input;
  const expanded = expandHomePath(unescaped, homeDir);
  const hasSlash = expanded.includes("/");

  if (!hasSlash) {
    return { dir: cwd, prefix: expanded, displayPrefix: "" };
  }

  const baseDir = expanded.endsWith("/") ? expanded : dirname(expanded);
  const dir = isAbsolute(baseDir) ? baseDir : resolve(cwd, baseDir);
  const prefix = expanded.endsWith("/") ? "" : basename(expanded);
  const displayPrefix = unescaped.endsWith("/") ? unescaped : unescaped.slice(0, Math.max(0, unescaped.length - prefix.length));
  return { dir, prefix, displayPrefix };
}

function isDirectoryEntry(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

export function getCdArgumentCompletions(argumentPrefix: string, cwd: string, homeDir = homedir()): AutocompleteItem[] {
  const prefix = argumentPrefix.trimStart();
  const suggestions: AutocompleteItem[] = [];

  for (const quickPick of ["../", "~/"]) {
    if (!prefix || quickPick.startsWith(prefix)) {
      suggestions.push({ value: quickPick, label: quickPick, description: quickPick === "../" ? "Parent directory" : "Home directory" });
    }
  }

  const { dir, prefix: entryPrefix, displayPrefix } = pathBase(prefix, cwd, homeDir);

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(entryPrefix) && (entry.isDirectory() || entry.isSymbolicLink() && isDirectoryEntry(dir, entry.name)))
      .slice(0, 50)
      .map((entry) => {
        const path = displayPath(`${displayPrefix}${entry.name}/`);
        return {
          value: escapeCompletionPath(path),
          label: path,
        } satisfies AutocompleteItem;
      });

    suggestions.push(...entries);
  } catch {
    return suggestions;
  }

  const seen = new Set<string>();
  return suggestions.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

export function createCdSession(source: ExtensionCommandContext["sessionManager"], target: string): string {
  const sourceFile = source.getSessionFile();
  if (!sourceFile) throw new Error("/cd 不支持 --no-session 会话，请使用普通持久化会话");
  let next: SessionManager;
  if (existsSync(sourceFile)) next = SessionManager.forkFrom(sourceFile, target);
  else {
    // 新会话尚未落盘时完整保留现有条目，只创建目标文件，不写入源会话。
    const fresh = SessionManager.create(target);
    const entries = [fresh.getHeader(), ...source.getEntries()];
    writeFileSync(fresh.getSessionFile()!, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    next = SessionManager.open(fresh.getSessionFile()!);
  }
  const leaf = source.getLeafId();
  if (next.getLeafId() !== leaf) {
    // forkFrom 默认选磁盘最后条目；用非模型元数据保留当前选择，避免切换到已放弃的分支。
    if (leaf === null) next.resetLeaf(); else next.branch(leaf);
    next.appendCustomEntry("pi-utils:cd");
  }
  return next.getSessionFile()!;
}

export async function runCdCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const resolved = resolveCdTarget(args, ctx.cwd);
  if (resolved === null) {
    ctx.ui.notify(ctx.cwd, "info");
    return;
  }
  if ("error" in resolved) {
    ctx.ui.notify(resolved.error, "error");
    return;
  }
  if (resolved.path === ctx.cwd) {
    ctx.ui.notify(`Already in ${ctx.cwd}`, "info");
    return;
  }

  await ctx.waitForIdle();
  const nextSessionFile = createCdSession(ctx.sessionManager, resolved.path);
  // 切换后旧 ctx 失效；只使用 Pi 提供的新上下文，不改写 prompt 或历史消息。
  const result = await ctx.switchSession(nextSessionFile, {
    withSession: async nextCtx => {
      process.chdir(nextCtx.cwd);
    },
  });
  if (result.cancelled) {
    try { unlinkSync(nextSessionFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ctx.ui.notify("目录切换已取消", "warning");
  }
  // 切换异常交由宿主报告；不删除可能已成为当前会话的文件。
}

export function registerCdCommand(pi: ExtensionAPI, getCwd: () => string): void {
  pi.registerCommand("cd", {
    description: "切换目录并保留会话历史；不带参数显示当前目录",
    getArgumentCompletions(argumentPrefix) {
      return getCdArgumentCompletions(argumentPrefix, getCwd());
    },
    handler: runCdCommand,
  });
}
