import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pin-model: keep the default model in settings.json fixed.
 *
 * Background: every /model selection or Ctrl+P cycle persists the newly
 * selected model into settings.json (defaultProvider/defaultModel), so the
 * next session inherits it. This extension captures the values from
 * settings.json at startup as the "pin", then reverts the two fields right
 * after each user-initiated model switch, making the switch session-local.
 *
 * Concurrency model:
 * - Cross-process mutual exclusion uses the same on-disk protocol as pi's
 *   SettingsManager (proper-lockfile): a `settings.json.lock` directory,
 *   created atomically with mkdir, removed with rmdir, considered stale
 *   after 10 seconds.
 * - Writes are atomic (same-directory temp file + fsync + rename) and only
 *   touch the two default-model fields; unknown fields and concurrent
 *   writes by other pi processes are preserved.
 * - Restore is compare-and-set: the file is only rewritten when its current
 *   default model is exactly the value this process last observed being
 *   persisted, so a second pi process that pinned a different model (via
 *   /model-pin set) is never clobbered on this process's exit.
 *
 * Commands:
 *   /model-pin       show the current pinned model
 *   /model-pin set   pin the current session model as the new default
 *                    (this one really persists to settings.json)
 */

type Settings = Record<string, unknown> & {
	defaultProvider?: string;
	defaultModel?: string;
};

interface ModelPin {
	provider: string;
	model: string;
}

const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 12;
const LOCK_BUSY_WAIT_MS = 25;
const DISK_WAIT_ATTEMPTS = 80;
const DISK_WAIT_INTERVAL_MS = 25;

export function getSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "settings.json");
}

interface ReadResult {
	exists: boolean;
	settings: Settings;
}

/**
 * Read settings.json strictly. A missing file is reported as {exists: false};
 * any other failure (permissions, transient read error, invalid JSON) throws
 * so callers never mistake a broken file for an empty one.
 */
export function readSettingsStrict(path = getSettingsPath()): ReadResult {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, settings: {} };
		throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("not a JSON object");
		}
		return { exists: true, settings: parsed as Settings };
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${(error as Error).message}); refusing to modify it.`);
	}
}

function currentPin(settings: Settings): ModelPin | undefined {
	if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
		return { provider: settings.defaultProvider, model: settings.defaultModel };
	}
	return undefined;
}

/**
 * Run fn while holding the settings.json lock directory, using the same
 * protocol as proper-lockfile (pi's SettingsManager), so pi's own writes and
 * this extension's writes exclude each other across processes.
 */
function withSettingsLock<T>(path: string, fn: () => T): T {
	const lockPath = `${path}.lock`;
	let acquired = false;
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			mkdirSync(lockPath);
			acquired = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Stale-lock recovery, matching proper-lockfile's 10s default.
			try {
				const stat = statSync(lockPath);
				if (stat.mtimeMs < Date.now() - LOCK_STALE_MS) {
					rmdirSync(lockPath);
					continue;
				}
			} catch (staleError) {
				if ((staleError as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
			if (attempt === LOCK_ATTEMPTS - 1) break;
			const deadline = Date.now() + LOCK_BUSY_WAIT_MS;
			while (Date.now() < deadline) {
				// Brief synchronous wait, mirroring pi's SettingsManager lock retry.
			}
		}
	}
	if (!acquired) {
		throw new Error(`Could not acquire the settings lock (${lockPath}); another pi process may be writing.`);
	}
	try {
		return fn();
	} finally {
		try {
			rmdirSync(lockPath);
		} catch {
			// Best effort; a crashed holder is recovered via staleness.
		}
	}
}

/** Atomic same-directory write: temp file, fsync, rename. */
function atomicWrite(path: string, text: string): void {
	const temp = join(dirname(path), `.${basename(path)}.pin-model-${process.pid}-${Date.now()}.tmp`);
	writeFileSync(temp, text, "utf-8");
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Ignore; rename failure already surfaces.
		}
		throw error;
	}
}

function serialize(settings: Settings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Set defaultProvider/defaultModel under the settings lock, preserving every
 * other field and any concurrent changes made by other processes.
 */
export function writePinnedModel(pin: ModelPin, path = getSettingsPath()): void {
	withSettingsLock(path, () => {
		const { exists, settings } = readSettingsStrict(path);
		if (!exists) {
			throw new Error(`${path} does not exist; start pi once before pinning a model.`);
		}
		settings.defaultProvider = pin.provider;
		settings.defaultModel = pin.model;
		atomicWrite(path, serialize(settings));
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the queued settings write of `expected` lands on disk (pi emits
 * model_select after enqueueing the persist), then compare-and-set the file
 * back to `pin`. The file is only rewritten while its current default model
 * still equals `expected`; if another process changed it, we leave it alone.
 */
export async function waitAndRestorePin(expected: ModelPin, pin: ModelPin, path = getSettingsPath()): Promise<boolean> {
	for (let attempt = 0; attempt < DISK_WAIT_ATTEMPTS; attempt++) {
		let disk: ModelPin | undefined;
		try {
			disk = withSettingsLock(path, () => currentPin(readSettingsStrict(path).settings));
		} catch {
			return false;
		}
		if (disk === undefined) return false;
		if (disk.provider === expected.provider && disk.model === expected.model) {
			try {
				withSettingsLock(path, () => {
					const current = currentPin(readSettingsStrict(path).settings);
					if (!current || current.provider !== expected.provider || current.model !== expected.model) return;
					const { settings } = readSettingsStrict(path);
					settings.defaultProvider = pin.provider;
					settings.defaultModel = pin.model;
					atomicWrite(path, serialize(settings));
				});
				return true;
			} catch {
				return false;
			}
		}
		if (disk.provider !== pin.provider || disk.model !== pin.model) {
			// A third value: another process pinned something else. Never clobber it.
			return true;
		}
		// Disk still holds the pinned value: pi's queued write has not landed
		// yet. Wait briefly for it.
		await sleep(DISK_WAIT_INTERVAL_MS);
	}
	// The expected write never appeared; report failure so shutdown retries.
	return false;
}

export default function (pi: ExtensionAPI) {
	const path = getSettingsPath();
	let startupError: Error | undefined;
	let pinned: ModelPin | undefined;
	try {
		pinned = currentPin(readSettingsStrict(path).settings);
	} catch (error) {
		// Stay loaded but inert: a broken settings.json must never be "fixed"
		// by rewriting it from partial state.
		startupError = error instanceof Error ? error : new Error(String(error));
	}
	// The model this process last saw persisted by a model switch; only this
	// value may be reverted on shutdown (compare-and-set).
	let lastSwitched: ModelPin | undefined;

	// pi persists the switched model to settings.json (queued write) before
	// emitting model_select, and awaits async handlers. Wait for the write to
	// land, then revert the two fields. All switch sources are covered;
	// "restore" is currently unused by pi but would equally need reverting.
	pi.on("model_select", async (event) => {
		if (!pinned) return;
		const switched = { provider: event.model.provider, model: event.model.id };
		const restored = await waitAndRestorePin(switched, pinned, path);
		if (!restored) {
			// Retry once more at shutdown.
			lastSwitched = switched;
		}
	});

	// Safety net: if a queued write or a mid-session settings save flushed the
	// switched model to disk after the handler ran, revert it on shutdown.
	// Compare-and-set keeps other processes' pins intact.
	pi.on("session_shutdown", async () => {
		if (!pinned || !lastSwitched) return;
		await waitAndRestorePin(lastSwitched, pinned, path);
	});

	pi.registerCommand("model-pin", {
		description: "Show pinned default model; `set` pins the current model as default",
		handler: async (args, ctx) => {
			const arg = args?.trim();
			if (startupError) {
				ctx.ui.notify(`model-pin is disabled: ${startupError.message}`, "error");
				return;
			}
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
				const next = { provider: model.provider, model: model.id };
				try {
					writePinnedModel(next, path);
					pinned = next;
					lastSwitched = undefined;
					ctx.ui.notify(`Pinned default model: ${model.provider}/${model.id}`, "info");
				} catch (error) {
					ctx.ui.notify(`Failed to pin model: ${(error as Error).message}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /model-pin [set]", "warning");
		},
	});
}
