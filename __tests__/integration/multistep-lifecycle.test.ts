import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PlanStore, parsePlan } from "../../src/persistence/plan-store.js";

/**
 * Regression test for Bug 1: multi-step plans losing steps during
 * approve/update roundtrip through parsePlan().
 */
describe("Multi-step plan lifecycle (Bug 1 regression)", () => {
	let tmpDir: string;
	let store: PlanStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-multistep-"));
		store = new PlanStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("2-step plan survives approve roundtrip", async () => {
		const plan = await store.create({
			title: "Two-step plan",
			steps: [
				{ description: "Search for test partner in Odoo", tool: "odoo-toolbox", operation: "search", target: "res.partner" },
				{ description: "Send test notification email", tool: "go-easy", operation: "send", target: "test@example.com" },
			],
			tools_required: ["odoo-toolbox", "go-easy"],
		});

		expect(plan.steps).toHaveLength(2);

		// Approve triggers update() which roundtrips through parsePlan
		const approved = await store.approve(plan.id);
		expect(approved.steps).toHaveLength(2);
		expect(approved.steps[0].description).toBe("Search for test partner in Odoo");
		expect(approved.steps[1].description).toBe("Send test notification email");

		// Verify on disk
		const filePath = path.join(tmpDir, ".pi", "plans", `${plan.id}.md`);
		const content = fs.readFileSync(filePath, "utf-8");
		const fromDisk = parsePlan(content);
		expect(fromDisk.steps).toHaveLength(2);
	});

	it("3-step plan survives full lifecycle", async () => {
		const plan = await store.create({
			title: "Three-step plan",
			steps: [
				{ description: "Read invoice from Odoo", tool: "odoo-toolbox", operation: "read", target: "INV-001" },
				{ description: "Send email reminder", tool: "go-easy", operation: "send" },
				{ description: "Update invoice status", tool: "odoo-toolbox", operation: "write", target: "INV-001" },
			],
			tools_required: ["odoo-toolbox", "go-easy"],
			context: "Invoice overdue by 30 days.",
		});

		const approved = await store.approve(plan.id);
		expect(approved.steps).toHaveLength(3);

		const executing = await store.markExecuting(plan.id);
		expect(executing.steps).toHaveLength(3);

		const completed = await store.markCompleted(plan.id, "All 3 steps done.");
		expect(completed.steps).toHaveLength(3);
		expect(completed.steps[0].description).toBe("Read invoice from Odoo");
		expect(completed.steps[1].description).toBe("Send email reminder");
		expect(completed.steps[2].description).toBe("Update invoice status");
		expect(completed.context).toBe("Invoice overdue by 30 days.");
	});

	it("5-step plan survives approve + reject with feedback", async () => {
		const plan = await store.create({
			title: "Five-step plan",
			steps: [
				{ description: "Step 1", tool: "t1", operation: "op1" },
				{ description: "Step 2", tool: "t2", operation: "op2", target: "tgt2" },
				{ description: "Step 3", tool: "t3", operation: "op3" },
				{ description: "Step 4", tool: "t4", operation: "op4", target: "tgt4" },
				{ description: "Step 5", tool: "t5", operation: "op5" },
			],
			tools_required: ["t1", "t2", "t3", "t4", "t5"],
		});

		// First reject with feedback
		const rejected = await store.reject(plan.id, "Wrong approach");
		expect(rejected.steps).toHaveLength(5);
		expect(rejected.body).toContain("Wrong approach");

		// Verify all steps survived the rejection roundtrip
		store.invalidateCache();
		const fromDisk = await store.get(plan.id);
		expect(fromDisk!.steps).toHaveLength(5);
		expect(fromDisk!.steps[4].description).toBe("Step 5");
	});

	it("steps with context — context does not eat steps", async () => {
		const plan = await store.create({
			title: "Plan with context",
			steps: [
				{ description: "Read data", tool: "odoo-toolbox", operation: "read" },
				{ description: "Process data", tool: "odoo-toolbox", operation: "write" },
			],
			tools_required: ["odoo-toolbox"],
			context: "Some important context here.\nWith multiple lines.",
		});

		const approved = await store.approve(plan.id);
		expect(approved.steps).toHaveLength(2);
		expect(approved.context).toContain("Some important context here.");
		expect(approved.context).toContain("With multiple lines.");
	});
});
