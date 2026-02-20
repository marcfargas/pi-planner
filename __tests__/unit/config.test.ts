import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../../src/persistence/config.js";
import { DEFAULT_CONFIG } from "../../src/persistence/types.js";

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-config-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns defaults when .pi/plans.json does not exist", () => {
		const config = loadConfig(tmpDir);
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	it("reads guardedTools from config", () => {
		const configDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "plans.json"),
			JSON.stringify({ guardedTools: ["odoo_create", "gmail_send"] }),
		);
		const config = loadConfig(tmpDir);
		expect(config.guardedTools).toEqual(["odoo_create", "gmail_send"]);
	});

	it("reads stale_after_days from config", () => {
		const configDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "plans.json"),
			JSON.stringify({ stale_after_days: 7 }),
		);
		const config = loadConfig(tmpDir);
		expect(config.stale_after_days).toBe(7);
		expect(config.guardedTools).toEqual([]); // default
	});

	it("uses defaults for invalid types", () => {
		const configDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "plans.json"),
			JSON.stringify({ guardedTools: "not-an-array", stale_after_days: "not-a-number" }),
		);
		const config = loadConfig(tmpDir);
		expect(config.guardedTools).toEqual([]);
		expect(config.stale_after_days).toBe(30);
	});

	it("handles malformed JSON gracefully", () => {
		const configDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "plans.json"), "not json");
		const config = loadConfig(tmpDir);
		expect(config).toEqual(DEFAULT_CONFIG);
	});
});
