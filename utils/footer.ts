import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { QUOTA_STATUS } from "./quota/index.ts";
import { formatRun, type RunStats } from "./run-stats.ts";

export interface FooterView {
  model: string;
  thinking: string;
  cwd: string;
  home: string;
  branch?: string | null;
  contextPercent?: number | null;
  contextWindow?: number;
  quota?: string;
  run?: RunStats;
  statuses: readonly (readonly [string, string])[];
}
export function singleLine(value: string): string {
  return value.replace(/\u001b\][^\u0007]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}
export function footerLines(view: FooterView, width: number, theme?: Pick<Theme, "fg">): string[] {
  if (width < 1) return [];
  const paint = (color: "dim" | "warning" | "error", text: string) => theme ? theme.fg(color, text) : text;
  // 沿用原生 Pi 的阈值，按显示舍入前的占用率判断。
  const percent = view.contextPercent ?? 0;
  const contextColor = percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
  // 沿用原生 Pi 的规则：仅缩写主目录及其子目录。
  const homeRelative = view.home ? relative(resolve(view.home), resolve(view.cwd)) : undefined;
  const insideHome = homeRelative !== undefined && homeRelative !== ".."
    && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative);
  const cwd = insideHome ? (homeRelative ? `~${sep}${homeRelative}` : "~") : view.cwd;
  const location = singleLine(cwd) + (view.branch ? ` (${singleLine(view.branch)})` : "");
  const locationLine = paint("dim", truncateToWidth(location, width, "..."));
  const context = `${view.contextPercent == null ? "—" : `${view.contextPercent.toFixed(1)}%`}/${view.contextWindow ? `${Math.round(view.contextWindow / 1000)}K` : "—"}`;
  const extensionStatuses = [...view.statuses]
    .filter(([key]) => key !== QUOTA_STATUS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => singleLine(value)).filter(Boolean);
  const right = paint("dim", [view.model, view.thinking].filter(Boolean).map(singleLine).join(" "));
  // 先清理外部文本，再添加主题转义序列；各字段独立着色。
  const left = [context, view.quota, view.run && formatRun(view.run)]
    .map((value, index) => typeof value === "string" && value.length > 0
      ? paint(index === 0 ? contextColor : "dim", singleLine(value)) : "")
    .filter(Boolean).join(" ");
  const availableLeft = width - visibleWidth(right) - 2;
  let statsLine: string;
  if (availableLeft < 1) statsLine = truncateToWidth(right, width, "...");
  else {
    const compactLeft = truncateToWidth(left, availableLeft, "...");
    statsLine = compactLeft + " ".repeat(width - visibleWidth(compactLeft) - visibleWidth(right)) + right;
  }
  const lines = [locationLine, statsLine];
  if (extensionStatuses.length) lines.push(paint("dim", truncateToWidth(extensionStatuses.join(" "), width, "...")));
  return lines;
}
export function registerFooter(pi: ExtensionAPI, stats: () => RunStats | undefined): () => void {
  let redraw = () => {};
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, data) => {
      const refresh = () => tui.requestRender();
      redraw = refresh;
      const unsubscribe = data.onBranchChange(refresh);
      return {
        invalidate() {},
        dispose() { unsubscribe(); if (redraw === refresh) redraw = () => {}; },
        render(width) {
          const statuses = data.getExtensionStatuses();
          const usage = ctx.getContextUsage();
          return footerLines({
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model",
            thinking: pi.getThinkingLevel(), cwd: ctx.cwd, home: homedir(), branch: data.getGitBranch(),
            contextPercent: usage?.percent, contextWindow: usage?.contextWindow,
            quota: statuses.get(QUOTA_STATUS), run: stats(),
            statuses: [...statuses],
          }, width, theme);
        },
      };
    });
  });
  const refresh = () => redraw();
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("message_end", refresh);
  pi.on("session_compact", refresh);
  pi.on("session_tree", refresh);
  pi.on("session_shutdown", (_event, ctx) => {
    redraw = () => {};
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
  return () => redraw();
}
