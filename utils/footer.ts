import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  const context = `${view.contextPercent == null ? "—" : `${view.contextPercent.toFixed(1)}%`}/${view.contextWindow ? `${Math.round(view.contextWindow / 1000)}k` : "—"}`;
  const right = [view.model, view.thinking].filter(Boolean).map(singleLine).join(" • ");
  const left = [cwd, view.branch, context, view.quota, view.run && formatRun(view.run), ...view.statuses]
    .filter((value): value is string => typeof value === "string" && value.length > 0).map(singleLine).join(" ");
  const availableLeft = width - visibleWidth(right) - 2;
  if (availableLeft < 1) return [truncateToWidth(right, width, "...")];
  const compactLeft = truncateToWidth(left, availableLeft, "...");
  return [compactLeft + " ".repeat(width - visibleWidth(compactLeft) - visibleWidth(right)) + right];
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
            model: ctx.model ? `(${ctx.model.provider}) ${ctx.model.id}` : "no model",
            thinking: pi.getThinkingLevel(), cwd: ctx.cwd, home: homedir(), branch: data.getGitBranch(),
            contextPercent: usage?.percent, contextWindow: usage?.contextWindow,
            quota: statuses.get(QUOTA_STATUS), run: stats(),
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
