export const META_PREFIX = "@@PI_UTILS_META_V1@@";

export interface StartMetadata {
	kind: "start";
	title: string;
	sessionName?: string;
}

export interface EndMetadata {
	kind: "end";
	recap: string;
}

export interface ParsedMetadata {
	start?: StartMetadata;
	end?: EndMetadata;
	text: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeLabel(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, maxLength).join("");
}

function decodeRecord(line: string): StartMetadata | EndMetadata | undefined {
	if (!line.startsWith(META_PREFIX)) return undefined;
	try {
		const parsed = JSON.parse(line.slice(META_PREFIX.length)) as unknown;
		if (!isObject(parsed) || parsed.v !== 1) return undefined;
		if (parsed.kind === "start" && typeof parsed.title === "string") {
			const title = sanitizeLabel(parsed.title, 36);
			if (!title) return undefined;
			const sessionName = typeof parsed.sessionName === "string"
				? sanitizeLabel(parsed.sessionName, 48)
				: undefined;
			return { kind: "start", title, ...(sessionName ? { sessionName } : {}) };
		}
		if (parsed.kind === "end" && typeof parsed.recap === "string") {
			const recap = sanitizeLabel(parsed.recap, 120);
			return recap ? { kind: "end", recap } : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function parseAndStripMetadata(text: string): ParsedMetadata {
	let start: StartMetadata | undefined;
	let end: EndMetadata | undefined;
	const kept: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith(META_PREFIX)) {
			const record = decodeRecord(line);
			if (record?.kind === "start") start = record;
			if (record?.kind === "end") end = record;
			if (record) continue;
		}
		kept.push(line);
	}
	return {
		...(start ? { start } : {}),
		...(end ? { end } : {}),
		text: kept.join("\n").replace(/^\n+|\n+$/g, ""),
	};
}

export const RECAP_ENTRY = "pi-utils:session-meta:recap";

export function branchRecaps(entries: readonly unknown[], limit = 30): string[] {
	const recaps: string[] = [];
	for (const entry of entries) {
		if (!isObject(entry) || entry.type !== "custom" || entry.customType !== RECAP_ENTRY || !isObject(entry.data)) continue;
		const data = entry.data;
		if (typeof data.recap !== "string" || typeof data.createdAt !== "number" || !Number.isSafeInteger(data.createdAt) || data.createdAt < 0 ||
			!data.recap || [...data.recap].length > 120 || sanitizeLabel(data.recap, 120) !== data.recap) continue;
		recaps.push(data.recap);
	}
	return recaps.slice(-limit);
}

export function recapMarkdown(recaps: readonly string[]): string {
	const escape = (text: string) => text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, "\\$&");
	return `# Current branch recaps\n\n${recaps.length ? recaps.map((recap) => `- ${escape(recap)}`).join("\n") : "No recaps on this branch."}\n`;
}

export function hideStreamingMetadata(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("@@PI_UTILS_META"))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}
