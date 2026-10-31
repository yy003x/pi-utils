import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { QUOTA_STATUS } from "./quota/index.ts";
import { formatRun, type RunStats } from "./run-stats.ts";

export interface FooterView {
  model: string;
  thinking: string;
  cwd: string;
  home: string;
  branch?: string | null;
  contextPercent?: number | null;
  quota?: string;
  run?: RunStats;
  statuses: readonly string[];
}
export function singleLine(value: string): string {
  return value.replace(/\u001b\][^\u0007]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}
export function footerLines(view: FooterView, width: number): string[] {
  if (width < 1) return [];
  const cwd = view.cwd === view.home ? "~" : view.cwd.startsWith(view.home + sep) ? "~" + view.cwd.slice(view.home.length) : view.cwd;
  const context = view.contextPercent == null ? "上下文 —" : `上下文 ${view.contextPercent.toFixed(0)}%`;
  const first = [view.model, view.thinking, context, cwd, view.branch].filter(Boolean).map(value => singleLine(value!)).join(" · ");
  const second = [view.quota && `额度 ${view.quota}`, view.run && formatRun(view.run), ...view.statuses]
    .filter((value): value is string => typeof value === "string" && value.length > 0).map(singleLine).join(" · ");
  return [first, ...(second ? [second] : [])].map(line => truncateToWidth(line, width));
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
          return footerLines({
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选模型",
            thinking: pi.getThinkingLevel(), cwd: ctx.cwd, home: homedir(), branch: data.getGitBranch(),
            contextPercent: ctx.getContextUsage()?.percent, quota: statuses.get(QUOTA_STATUS), run: stats(),
            statuses: [...statuses].filter(([key]) => key !== QUOTA_STATUS).map(([, value]) => value),
          }, width).map(line => theme.fg("dim", line));
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
