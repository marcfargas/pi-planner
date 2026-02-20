import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CheckpointLogger, readCheckpoint, countCompletedSteps } from "../../src/executor/checkpoint.js";

describe("CheckpointLogger", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-ckpt-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates checkpoint file and logs start", () => {
		const logger = new CheckpointLogger(tmpDir, "PLAN-abc123");
		logger.logStart("PLAN-abc123");

		const content = fs.readFileSync(logger.getFilePath(), "utf-8");
		expect(content).toContain("execution_start");
		expect(content).toContain("PLAN-abc123");
	});

	it("logs step checkpoints", () => {
		const logger = new CheckpointLogger(tmpDir, "PLAN-abc123");
		logger.logStep({
			step: 1,
			tool: "odoo-toolbox",
			operation: "read",
			status: "success",
			result_summary: "Invoice found",
			timestamp: new Date().toISOString(),
		});

		const content = fs.readFileSync(logger.getFilePath(), "utf-8");
		expect(content).toContain("odoo-toolbox");
		expect(content).toContain("Invoice found");
	});

	it("logs execution end", () => {
		const logger = new CheckpointLogger(tmpDir, "PLAN-abc123");
		logger.logEnd("PLAN-abc123", "completed", "All steps done");

		const content = fs.readFileSync(logger.getFilePath(), "utf-8");
		expect(content).toContain("execution_end");
		expect(content).toContain("completed");
	});

	it("creates sessions subdirectory", () => {
		new CheckpointLogger(tmpDir, "PLAN-xyz");
		const sessionsDir = path.join(tmpDir, ".pi", "plans", "sessions");
		expect(fs.existsSync(sessionsDir)).toBe(true);
	});
});

describe("readCheckpoint", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-ckpt-read-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when no checkpoint exists", () => {
		const steps = readCheckpoint(tmpDir, "PLAN-nonexistent");
		expect(steps).toEqual([]);
	});

	it("reads step checkpoints from file", () => {
		const logger = new CheckpointLogger(tmpDir, "PLAN-abc123");
		logger.logStart("PLAN-abc123");
		logger.logStep({
			step: 1, tool: "odoo", operation: "read",
			status: "success", timestamp: new Date().toISOString(),
		});
		logger.logStep({
			step: 2, tool: "gmail", operation: "send",
			status: "failed", error: "Recipient not found",
			timestamp: new Date().toISOString(),
		});

		const steps = readCheckpoint(tmpDir, "PLAN-abc123");
		expect(steps).toHaveLength(2);
		expect(steps[0].status).toBe("success");
		expect(steps[1].status).toBe("failed");
		expect(steps[1].error).toBe("Recipient not found");
	});
});

describe("countCompletedSteps", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-ckpt-count-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns 0 when no checkpoint exists", () => {
		expect(countCompletedSteps(tmpDir, "PLAN-nope")).toBe(0);
	});

	it("counts only successful steps", () => {
		const logger = new CheckpointLogger(tmpDir, "PLAN-abc");
		logger.logStep({ step: 1, tool: "a", operation: "x", status: "success", timestamp: "" });
		logger.logStep({ step: 2, tool: "b", operation: "y", status: "failed", timestamp: "" });
		logger.logStep({ step: 3, tool: "c", operation: "z", status: "success", timestamp: "" });

		expect(countCompletedSteps(tmpDir, "PLAN-abc")).toBe(2);
	});
});
