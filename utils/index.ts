import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCdCommand } from "../cd-command.ts";
import { registerFooter } from "./footer.ts";
import { registerQuota } from "./quota/index.ts";
import { registerRunStats } from "./run-stats.ts";

export default function piUtils(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  let redraw = () => {};
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
  const stats = registerRunStats(pi, () => redraw());
  registerQuota(pi, () => redraw());
  redraw = registerFooter(pi, stats);
  registerCdCommand(pi, () => cwd);
}
