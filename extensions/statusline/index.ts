import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { collectUsageTotals, formatDuration, formatTokens, oneLine } from "./core.ts";

const USAGE_STATUS_KEY = "subscription-usage";
const METRICS_EVENT = "pi-utils/turn-metrics/updated/v1";

interface TurnMetricsEvent {
	durationMs: number;
}

function parseTurnMetrics(value: unknown): TurnMetricsEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const durationMs = (value as { durationMs?: unknown }).durationMs;
	return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
		? { durationMs }
		: undefined;
}

function isSubscriptionModel(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return false;
	return ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;
}

export default function statusline(pi: ExtensionAPI): void {
	let latestDurationMs: number | undefined;
	let requestRender: (() => void) | undefined;

	pi.events.on(METRICS_EVENT, (value) => {
		latestDurationMs = parseTurnMetrics(value)?.durationMs;
		requestRender?.();
	});

	const settingsCache = new Map<string, { stamp: string; enabled: boolean | undefined }>();
	function readAutoCompact(path: string): boolean | undefined {
		try {
			const stat = statSync(path);
			const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
			const cached = settingsCache.get(path);
			if (cached?.stamp === stamp) return cached.enabled;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				compaction?: { enabled?: unknown };
			};
			const enabled = typeof parsed.compaction?.enabled === "boolean"
				? parsed.compaction.enabled
				: undefined;
			settingsCache.set(path, { stamp, enabled });
			return enabled;
		} catch {
			settingsCache.delete(path);
			return undefined;
		}
	}

	function autoCompactEnabled(ctx: ExtensionContext): boolean {
		const global = readAutoCompact(join(getAgentDir(), "settings.json"));
		const project = ctx.isProjectTrusted()
			? readAutoCompact(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
			: undefined;
		return project ?? global ?? true;
	}

	pi.on("session_start", (_event, ctx) => {
		latestDurationMs = undefined;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);
			return {
				dispose() {
					unsubscribe();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (width < 1) return [""];
					const dim = (text: string) => theme.fg("dim", text);
					const totals = collectUsageTotals(ctx.sessionManager.getEntries());

					let cwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home) {
						const local = relative(home, cwd);
						if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) {
							cwd = local ? `~${sep}${local}` : "~";
						}
					}
					const branch = footerData.getGitBranch();
					const name = ctx.sessionManager.getSessionName();
					const directory = oneLine(`${cwd}${branch ? ` (${branch})` : ""}${name ? ` • ${name}` : ""}`);

					const model = ctx.model;
					const context = ctx.getContextUsage();
					const tokens = context?.tokens;
					const percent = context?.percent;
					const auto = autoCompactEnabled(ctx) ? " (auto)" : "";
					const contextText = `${tokens == null ? "?" : formatTokens(tokens)} ${percent == null ? "?%" : `${Math.round(percent)}%`}${auto}`;
					const contextStat = theme.fg(
						(percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "dim",
						contextText,
					);

					const tokenStats: string[] = [];
					if (totals.input) tokenStats.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) tokenStats.push(`↓${formatTokens(totals.output)}`);
					const stats = [...tokenStats];
					if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead || totals.cacheWrite) && totals.latestCacheHitRate !== undefined) {
						stats.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost || isSubscriptionModel(ctx)) {
						stats.push(`$${totals.cost.toFixed(3)}${isSubscriptionModel(ctx) ? " (sub)" : ""}`);
					}
					if (latestDurationMs !== undefined) stats.push(`⏱${formatDuration(latestDurationMs)}`);

					const statuses = footerData.getExtensionStatuses();
					const quota = oneLine(statuses.get(USAGE_STATUS_KEY) ?? "");
					const quotaSuffix = quota ? `  ${quota}` : "";
					const thinking = pi.getThinkingLevel();
					const modelText = `${model?.id ?? "no-model"}${model?.reasoning ? ` • ${thinking === "off" ? "thinking off" : thinking}` : ""}`;
					const rightOptions = footerData.getAvailableProviderCount() > 1 && model
						? [`(${model.provider}) ${modelText}`, modelText]
						: [modelText];
					const leftOptions = [
						`${stats.length ? `${dim(stats.join(" "))} ` : ""}${contextStat}${quotaSuffix}`,
						`${tokenStats.length ? `${dim(tokenStats.join(" "))} ` : ""}${contextStat}${quotaSuffix}`,
						`${contextStat}${quotaSuffix}`,
					];

					let statsLine: string | undefined;
					for (const left of leftOptions) {
						for (const right of rightOptions) {
							const padding = width - visibleWidth(left) - visibleWidth(right);
							if (padding >= 2) {
								statsLine = left + " ".repeat(padding) + dim(right);
								break;
							}
						}
						if (statsLine !== undefined) break;
					}
					if (statsLine === undefined) {
						const left = truncateToWidth(quota || contextStat, width, "…");
						const room = width - visibleWidth(left) - 2;
						statsLine = room > 0
							? `${left}  ${dim(truncateToWidth(modelText, room, "…"))}`
							: left;
					}

					const lines = [
						truncateToWidth(dim(directory), width, "…"),
						truncateToWidth(statsLine, width, "…"),
					];
					const others = [...statuses.entries()]
						.filter(([key, text]) => key !== USAGE_STATUS_KEY && Boolean(text))
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => oneLine(text));
					if (others.length) lines.push(truncateToWidth(others.join("  "), width, "…"));
					return lines;
				},
			};
		});
	});

	const refresh = () => requestRender?.();
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("session_info_changed", refresh);
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		requestRender = undefined;
	});
}
