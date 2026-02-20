import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PlanStore } from "../../src/persistence/plan-store.js";

/**
 * Concurrency tests — optimistic locking, parallel writers, file integrity.
 */
describe("Concurrency", () => {
	let tmpDir: string;
	let store: PlanStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-planner-conc-"));
		store = new PlanStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("detects concurrent modification via version", async () => {
		const plan = await store.create({
			title: "Concurrent test",
			steps: [],
			tools_required: [],
		});

		// Store 1 reads plan
		const store1 = new PlanStore(tmpDir);
		const store2 = new PlanStore(tmpDir);

		// Store 1 updates first (approve)
		await store1.approve(plan.id);

		// Store 2 tries to update the same plan — should fail because version changed
		await expect(store2.approve(plan.id)).rejects.toThrow();
	});

	it("parallel creates don't conflict", async () => {
		const results = await Promise.all([
			store.create({ title: "A", steps: [], tools_required: [] }),
			store.create({ title: "B", steps: [], tools_required: [] }),
			store.create({ title: "C", steps: [], tools_required: [] }),
		]);

		expect(results).toHaveLength(3);
		const ids = new Set(results.map((p) => p.id));
		expect(ids.size).toBe(3); // All unique IDs

		const all = await store.list();
		expect(all).toHaveLength(3);
	});

	it("version increments are consistent across instances", async () => {
		const plan = await store.create({
			title: "Version test",
			steps: [],
			tools_required: [],
		});
		expect(plan.version).toBe(1);

		const approved = await store.approve(plan.id);
		expect(approved.version).toBe(2);

		// New store instance reads from disk
		const store2 = new PlanStore(tmpDir);
		const executing = await store2.markExecuting(plan.id);
		expect(executing.version).toBe(3);

		// Original store should see updated version after cache invalidation
		store.invalidateCache();
		const fromDisk = await store.get(plan.id);
		expect(fromDisk!.version).toBe(3);
	});

	it("temp files are cleaned up on conflict", async () => {
		const plan = await store.create({
			title: "Cleanup test",
			steps: [],
			tools_required: [],
		});

		const store1 = new PlanStore(tmpDir);
		const store2 = new PlanStore(tmpDir);

		await store1.approve(plan.id);

		// store2's update will fail
		try {
			await store2.approve(plan.id);
		} catch {
			// Expected
		}

		// No orphaned .tmp files should remain
		const plansDir = path.join(tmpDir, ".pi", "plans");
		const files = fs.readdirSync(plansDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp"));
		expect(tmpFiles).toHaveLength(0);
	});
});
