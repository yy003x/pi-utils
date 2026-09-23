import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UtilsSettings {
	statusline: { showCost: boolean; showDuration: boolean; showCache: boolean; showQuota: boolean; compactAtWidth?: number };
	notifications: { settleMs: number | undefined; userWaitMs: number | undefined };
}
const defaults: UtilsSettings = {
	statusline: { showCost: true, showDuration: true, showCache: true, showQuota: true },
	notifications: { settleMs: undefined, userWaitMs: undefined },
};
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
const settingsCache = new Map<string, { stamp: string; value: Record<string, unknown> }>();
function read(path: string): Record<string, unknown> {
	try {
		const stat = statSync(path);
		const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
		const cached = settingsCache.get(path);
		if (cached?.stamp === stamp) return cached.value;
		const json: unknown = JSON.parse(readFileSync(path, "utf8"));
		const value = object(json) && object(json.piUtils) ? json.piUtils : {};
		settingsCache.set(path, { stamp, value });
		return value;
	} catch { settingsCache.delete(path); return {}; }
}
export function resolveSettings(global: Record<string, unknown>, project: Record<string, unknown> = {}): UtilsSettings {
	const statusline: UtilsSettings["statusline"] = { ...defaults.statusline };
	const notifications = { ...defaults.notifications };
	for (const source of [global, project]) {
		if (object(source.statusline)) {
			for (const key of ["showCost", "showDuration", "showCache", "showQuota"] as const) {
				if (typeof source.statusline[key] === "boolean") statusline[key] = source.statusline[key];
			}
			const width = source.statusline.compactAtWidth;
			if (typeof width === "number" && Number.isSafeInteger(width) && width >= 40 && width <= 300) {
				statusline.compactAtWidth = width;
			}
		}
		if (object(source.notifications)) {
			for (const key of ["settleMs", "userWaitMs"] as const) {
				const value = source.notifications[key];
				if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1000 && value <= 86_400_000) notifications[key] = value;
			}
		}
	}
	return { statusline, notifications };
}
export function getUtilsSettings(ctx: ExtensionContext): UtilsSettings {
	return resolveSettings(read(join(getAgentDir(), "settings.json")),
		ctx.isProjectTrusted() ? read(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : {});
}
