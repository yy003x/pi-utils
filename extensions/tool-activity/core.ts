export interface ToolActivityItem {
	id: string;
	name: string;
}

export interface ToolActivityView {
	running: boolean;
	waitingTitle?: string;
	tools: readonly ToolActivityItem[];
}

export function sanitizeActivityText(value: string, maxLength = 80): string {
	const cleaned = value
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, maxLength).join("");
}

export function normalizeToolName(name: string): string {
	return sanitizeActivityText(name.replace(/^mcp__/, "mcp:").replaceAll("__", "/"));
}

export function renderToolActivity(view: ToolActivityView, maxItems = 5): string[] {
	if (view.waitingTitle) return [`Waiting for input · ${sanitizeActivityText(view.waitingTitle)}`];
	if (view.tools.length > 0) {
		const visible = view.tools.slice(-maxItems).map((tool) => normalizeToolName(tool.name));
		const hidden = Math.max(0, view.tools.length - visible.length);
		return [
			`Running tools (${view.tools.length}) · ${visible.join(" · ")}${hidden > 0 ? ` · +${hidden}` : ""}`,
		];
	}
	return view.running ? ["Agent working"] : [];
}
