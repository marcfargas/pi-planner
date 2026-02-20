import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PlanStore } from "../../src/persistence/plan-store.js";

/**
 * Full lifecycle integration test — uses real file I/O.
 * Tests the complete plan lifecycle: create → approve → execute → complete/fail.
 */
describe("Full plan lifecycle", () => {
	let tmpDir: string;
	let store: PlanStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-integ-"));
		store = new PlanStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("proposed → approved → executing → completed", async () => {
		// Create
		const plan = await store.create({
			title: "Send invoice reminder",
			steps: [
				{ description: "Read invoice from Odoo", tool: "odoo-toolbox", operation: "read", target: "INV-001" },
				{ description: "Send email reminder", tool: "go-easy", operation: "send" },
				{ description: "Update invoice status", tool: "odoo-toolbox", operation: "write", target: "INV-001" },
			],
			tools_required: ["odoo-toolbox", "go-easy"],
			context: "Invoice overdue by 30 days.",
		});
		expect(plan.status).toBe("proposed");
		expect(plan.version).toBe(1);

		// Approve
		const approved = await store.approve(plan.id);
		expect(approved.status).toBe("approved");
		expect(approved.version).toBe(2);

		// Mark executing
		const executing = await store.markExecuting(plan.id);
		expect(executing.status).toBe("executing");
		expect(executing.execution_started_at).toBeTruthy();
		expect(executing.version).toBe(3);

		// Mark completed
		const completed = await store.markCompleted(plan.id, "All 3 steps executed successfully.");
		expect(completed.status).toBe("completed");
		expect(completed.result_summary).toBe("All 3 steps executed successfully.");
		expect(completed.execution_ended_at).toBeTruthy();
		expect(completed.version).toBe(4);
	});

	it("proposed → approved → executing → failed", async () => {
		const plan = await store.create({
			title: "Failing plan",
			steps: [{ description: "Step that fails", tool: "odoo-toolbox", operation: "write" }],
			tools_required: ["odoo-toolbox"],
		});

		await store.approve(plan.id);
		await store.markExecuting(plan.id);
		const failed = await store.markFailed(plan.id, "Step 1 failed: record not found");
		expect(failed.status).toBe("failed");
		expect(failed.result_summary).toContain("record not found");
	});

	it("proposed → rejected with feedback", async () => {
		const plan = await store.create({
			title: "Bad plan",
			steps: [{ description: "Wrong step", tool: "odoo-toolbox", operation: "delete" }],
			tools_required: ["odoo-toolbox"],
		});

		const rejected = await store.reject(plan.id, "Don't delete records directly.");
		expect(rejected.status).toBe("rejected");
		expect(rejected.body).toContain("Don't delete records directly.");
	});

	it("proposed → cancelled", async () => {
		const plan = await store.create({
			title: "Stale plan",
			steps: [],
			tools_required: [],
		});

		const cancelled = await store.cancel(plan.id);
		expect(cancelled.status).toBe("cancelled");
	});

	it("survives process restart (cache invalidation)", async () => {
		// Create plan
		const plan = await store.create({
			title: "Persistent plan",
			steps: [{ description: "Survives restart", tool: "test", operation: "read" }],
			tools_required: ["test"],
		});
		await store.approve(plan.id);

		// Simulate restart: new store instance reads from disk
		const store2 = new PlanStore(tmpDir);
		const restored = await store2.get(plan.id);
		expect(restored).not.toBeNull();
		expect(restored!.title).toBe("Persistent plan");
		expect(restored!.status).toBe("approved");
		expect(restored!.version).toBe(2);
	});

	it("handles multiple concurrent plans", async () => {
		const p1 = await store.create({ title: "Plan A", steps: [], tools_required: ["odoo-toolbox"] });
		const p2 = await store.create({ title: "Plan B", steps: [], tools_required: ["go-easy"] });
		const p3 = await store.create({ title: "Plan C", steps: [], tools_required: ["odoo-toolbox"] });

		await store.approve(p1.id);
		await store.reject(p2.id, "Not needed");

		const proposed = await store.list({ status: "proposed" });
		expect(proposed).toHaveLength(1);
		expect(proposed[0].id).toBe(p3.id);

		const approved = await store.list({ status: "approved" });
		expect(approved).toHaveLength(1);
		expect(approved[0].id).toBe(p1.id);

		const all = await store.list();
		expect(all).toHaveLength(3);
	});

	it("file on disk is valid markdown with frontmatter", async () => {
		const plan = await store.create({
			title: "Markdown check",
			steps: [{ description: "Do something", tool: "test", operation: "op" }],
			tools_required: ["test"],
			context: "Some context here.",
		});

		const filePath = path.join(tmpDir, ".pi", "plans", `${plan.id}.md`);
		const content = fs.readFileSync(filePath, "utf-8");

		// Valid frontmatter structure
		expect(content).toMatch(/^---\n/);
		expect(content).toMatch(/\n---\n/);
		expect(content).toContain("id: PLAN-");
		expect(content).toContain("status: proposed");
		expect(content).toContain("version: 1");
		expect(content).toContain("## Steps");
		expect(content).toContain("## Context");
		expect(content).toContain("Some context here.");
	});
});
