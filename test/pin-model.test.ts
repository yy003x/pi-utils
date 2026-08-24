import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getSettingsPath, readSettingsStrict, waitAndRestorePin, writePinnedModel } from "../extensions/pin-model.ts";

let dir: string;
let settingsPath: string;

beforeEach(() => {
	dir = join(tmpdir(), `pin-model-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	settingsPath = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(dir, { recursive: true, force: true });
});

function writeRaw(text: string): void {
	writeFileSync(settingsPath, text, "utf-8");
}

describe("readSettingsStrict", () => {
	it("reports missing files as exists=false instead of empty settings", () => {
		const result = readSettingsStrict(settingsPath);
		assert.equal(result.exists, false);
		assert.deepEqual(result.settings, {});
	});

	it("reads a valid settings object", () => {
		writeRaw(JSON.stringify({ defaultProvider: "p", defaultModel: "m", theme: "dark" }));
		const result = readSettingsStrict(settingsPath);
		assert.equal(result.exists, true);
		assert.equal(result.settings.defaultModel, "m");
	});

	it("refuses to interpret invalid JSON as empty settings", () => {
		writeRaw("{ half-written");
		assert.throws(() => readSettingsStrict(settingsPath), /not valid JSON/);
	});

	it("refuses non-object JSON", () => {
		writeRaw("[1,2,3]");
		assert.throws(() => readSettingsStrict(settingsPath), /not a JSON object/);
	});
});

describe("writePinnedModel", () => {
	it("merges only the two model fields and preserves everything else", () => {
		writeRaw(JSON.stringify({ defaultProvider: "old", defaultModel: "old-model", packages: { a: 1 }, theme: "x" }, null, 2));
		writePinnedModel({ provider: "new", model: "new-model" }, settingsPath);
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.equal(parsed.defaultProvider, "new");
		assert.equal(parsed.defaultModel, "new-model");
		assert.deepEqual(parsed.packages, { a: 1 });
		assert.equal(parsed.theme, "x");
	});

	it("refuses to write when the file is missing", () => {
		assert.throws(() => writePinnedModel({ provider: "p", model: "m" }, settingsPath), /does not exist/);
		assert.equal(existsSync(settingsPath), false);
	});

	it("refuses to rewrite a corrupt settings file", () => {
		writeRaw("{ broken");
		assert.throws(() => writePinnedModel({ provider: "p", model: "m" }, settingsPath), /not valid JSON/);
		assert.equal(readFileSync(settingsPath, "utf-8"), "{ broken");
	});

	it("recovers a stale lock directory", () => {
		writeRaw(JSON.stringify({ defaultProvider: "p", defaultModel: "m" }));
		const lockPath = `${settingsPath}.lock`;
		mkdirSync(lockPath);
		const stale = new Date(Date.now() - 60_000);
		utimesSync(lockPath, stale, stale);
		writePinnedModel({ provider: "q", model: "n" }, settingsPath);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultModel, "n");
		assert.equal(existsSync(lockPath), false);
	});
});

describe("waitAndRestorePin", () => {
	it("restores the pin when disk still holds the switched model (CAS)", async () => {
		writeRaw(JSON.stringify({ defaultProvider: "switched", defaultModel: "switched-model", other: 42 }));
		const result = await waitAndRestorePin(
			{ provider: "switched", model: "switched-model" },
			{ provider: "pin", model: "pin-model" },
			settingsPath,
		);
		assert.equal(result, true);
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.equal(parsed.defaultProvider, "pin");
		assert.equal(parsed.defaultModel, "pin-model");
		assert.equal(parsed.other, 42);
	});

	it("never clobbers a third value written by another process", async () => {
		writeRaw(JSON.stringify({ defaultProvider: "other-proc", defaultModel: "other-model" }));
		const result = await waitAndRestorePin(
			{ provider: "switched", model: "switched-model" },
			{ provider: "pin", model: "pin-model" },
			settingsPath,
		);
		assert.equal(result, true);
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.equal(parsed.defaultModel, "other-model");
	});

	it("waits for a queued write to land, then restores", async () => {
		writeRaw(JSON.stringify({ defaultProvider: "pin", defaultModel: "pin-model" }));
		const expected = { provider: "switched", model: "switched-model" };
		const pin = { provider: "pin", model: "pin-model" };
		// Simulate pi's queued write landing shortly after the handler starts.
		const timer = setTimeout(() => {
			writeRaw(JSON.stringify({ defaultProvider: expected.provider, defaultModel: expected.model }));
		}, 60);
		const result = await waitAndRestorePin(expected, pin, settingsPath);
		clearTimeout(timer);
		assert.equal(result, true);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultModel, "pin-model");
	});

	it("reports failure when the expected write never appears", async () => {
		writeRaw(JSON.stringify({ defaultProvider: "pin", defaultModel: "pin-model" }));
		const result = await waitAndRestorePin(
			{ provider: "switched", model: "switched-model" },
			{ provider: "pin", model: "pin-model" },
			settingsPath,
		);
		assert.equal(result, false);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultModel, "pin-model");
	});
});

describe("getSettingsPath", () => {
	it("respects PI_CODING_AGENT_DIR", () => {
		assert.equal(getSettingsPath(), join(dir, "settings.json"));
	});
});
