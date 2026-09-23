export interface ToolActivityItem { id: string; name: string; startedAt?: number; }
export interface ToolActivityView {
	running: boolean;
	waitingTitle?: string;
	tools: readonly ToolActivityItem[];
	phase?: "agent" | "provider" | "tool" | "user wait";
	durationMs?: number;
	completed?: number;
	lastFailed?: string;
}
export function sanitizeActivityText(value: string, maxLength = 80): string {
	const cleaned = value.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ").trim();
	return [...cleaned].slice(0, maxLength).join("");
}
export function normalizeToolName(name: string): string {
	return sanitizeActivityText(name.replace(/^mcp__/, "mcp:").replaceAll("__", "/"));
}
export function renderToolActivity(view: ToolActivityView, maxItems = 5): string[] {
	const suffix = view.durationMs === undefined ? "" : ` · ${Math.floor(view.durationMs / 1000)}s`;
	const counts = view.completed === undefined ? "" : ` · ${view.completed} done / ${view.tools.length} running`;
	const failure = view.lastFailed ? ` · failed ${normalizeToolName(view.lastFailed).slice(0, 40)}` : "";
	if (view.waitingTitle) return [`User wait · ${sanitizeActivityText(view.waitingTitle)}${suffix}${counts}${failure}`];
	if (view.tools.length > 0) {
		const visible = view.tools.slice(-maxItems).map((tool) => normalizeToolName(tool.name));
		const hidden = Math.max(0, view.tools.length - visible.length);
		return [`Tools (${view.tools.length} concurrent)${suffix}${counts} · ${visible.join(" · ")}${hidden > 0 ? ` · +${hidden}` : ""}${failure}`];
	}
	return view.running ? [`${view.phase === "provider" ? "Provider" : "Agent"} working${suffix}${counts}${failure}`] : [];
}
