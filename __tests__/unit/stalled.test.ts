import { describe, it, expect } from "vitest";
import { findStalledPlans, formatStalledPlanMessage } from "../../src/executor/stalled.js";
import type { Plan } from "../../src/persistence/types.js";

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		id: "PLAN-deadbeef",
		title: "Test plan",
		status: "executing",
		version: 3,
		created_at: "2026-02-11T12:00:00Z",
		updated_at: "2026-02-11T12:05:00Z",
		tools_required: ["odoo-toolbox"],
		steps: [{ description: "Step 1", tool: "odoo-toolbox", operation: "read" }],
		execution_started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
		...overrides,
	};
}

describe("findStalledPlans", () => {
	it("returns empty for no executing plans", () => {
		expect(findStalledPlans([], 30)).toEqual([]);
	});

	it("returns plans exceeding timeout", () => {
		const plan = makePlan({
			execution_started_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(), // 45 min ago
		});
		const stalled = findStalledPlans([plan], 30); // 30 min timeout
		expect(stalled).toHaveLength(1);
		expect(stalled[0].id).toBe("PLAN-deadbeef");
	});

	it("does not return plans within timeout", () => {
		const plan = makePlan({
			execution_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
		});
		const stalled = findStalledPlans([plan], 30);
		expect(stalled).toHaveLength(0);
	});

	it("handles plans without execution_started_at", () => {
		const plan = makePlan({ execution_started_at: undefined });
		const stalled = findStalledPlans([plan], 30);
		expect(stalled).toHaveLength(0);
	});

	it("separates stalled from active plans", () => {
		const stalledPlan = makePlan({
			id: "PLAN-stalled",
			execution_started_at: new Date(Date.now() - 120 * 60 * 1000).toISOString(), // 2 hours
		});
		const activePlan = makePlan({
			id: "PLAN-active",
			execution_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min
		});
		const stalled = findStalledPlans([stalledPlan, activePlan], 30);
		expect(stalled).toHaveLength(1);
		expect(stalled[0].id).toBe("PLAN-stalled");
	});
});

describe("formatStalledPlanMessage", () => {
	it("includes plan ID and title", () => {
		const plan = makePlan({ title: "Send invoice reminder" });
		const msg = formatStalledPlanMessage(plan);
		expect(msg).toContain("PLAN-deadbeef");
		expect(msg).toContain("Send invoice reminder");
	});

	it("includes elapsed time", () => {
		const plan = makePlan({
			execution_started_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), // 90 min
		});
		const msg = formatStalledPlanMessage(plan);
		expect(msg).toContain("90m");
	});
});
