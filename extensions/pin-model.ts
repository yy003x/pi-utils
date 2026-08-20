import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pin-model: keep the default model in settings.json fixed.
 *
 * Background: every /model selection or Ctrl+P cycle writes the newly
 * selected model into settings.json (defaultProvider/defaultModel), so the
 * next session inherits it. This extension captures the values from
 * settings.json at startup as the "pin", then reverts the file right after
 * each user-initiated model switch, making the switch session-local.
 *
 * Commands:
 *   /model-pin       show the current pinned model
 *   /model-pin set   pin the current session model as the new default
 *                    (this one really persists to settings.json)
 */

function getSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "settings.json");
}

type Settings = Record<string, unknown> & {
	defaultProvider?: string;
	defaultModel?: string;
};

function readSettings(): Settings | undefined {
	try {
		return JSON.parse(readFileSync(getSettingsPath(), "utf-8")) as Settings;
	} catch {
		return undefined;
	}
}

function writeSettings(settings: Settings): void {
	writeFileSync(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export default function (pi: ExtensionAPI) {
	const initial = readSettings();
	let pinned =
		initial?.defaultProvider && initial?.defaultModel
			? { provider: initial.defaultProvider, model: initial.defaultModel }
			: undefined;

	function restorePin(): void {
		if (!pinned) return;
		const current = readSettings();
		if (!current) return;
		if (current.defaultProvider === pinned.provider && current.defaultModel === pinned.model) return;
		current.defaultProvider = pinned.provider;
		current.defaultModel = pinned.model;
		writeSettings(current);
	}

	function scheduleRestore(): void {
		// pi queues settings writes (enqueueWrite), so when model_select fires the
		// switched model may not be on disk yet. Defer past the write queue flush.
		setTimeout(() => {
			try {
				restorePin();
			} catch {
				// session_shutdown restore acts as fallback
			}
		}, 150);
	}

	// pi persists the switched model to settings.json before emitting
	// model_select, so revert the file here. "restore" (session resume) is
	// left untouched.
	pi.on("model_select", (event, _ctx) => {
		if (event.source === "restore") return;
		scheduleRestore();
	});

	// Any other settings save during the session (e.g. /settings changes)
	// flushes the in-memory switched model back to disk; revert on shutdown
	// so the file always ends up with the pinned value.
	pi.on("session_shutdown", async (_event, _ctx) => {
		await new Promise((resolve) => setTimeout(resolve, 150));
		restorePin();
	});

	pi.registerCommand("model-pin", {
		description: "Show pinned default model; `set` pins the current model as default",
		handler: (args, ctx) => {
			const arg = args?.trim();
			if (!arg) {
				ctx.ui.notify(
					pinned
						? `Pinned model: ${pinned.provider}/${pinned.model}`
						: "No pinned model (defaultModel missing in settings.json)",
					"info",
				);
				return;
			}
			if (arg === "set") {
				const model = ctx.model;
				if (!model) {
					ctx.ui.notify("No active model", "error");
					return;
				}
				pinned = { provider: model.provider, model: model.id };
				writeSettings({ ...(readSettings() ?? {}), defaultProvider: model.provider, defaultModel: model.id });
				ctx.ui.notify(`Pinned default model: ${model.provider}/${model.id}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /model-pin [set]", "warning");
		},
	});
}
