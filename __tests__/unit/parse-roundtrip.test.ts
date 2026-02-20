import { describe, it, expect } from "vitest";
import { serializePlan, parsePlan } from "../../src/persistence/plan-store.js";
import type { Plan } from "../../src/persistence/types.js";

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		id: "PLAN-deadbeef",
		title: "Test plan",
		status: "proposed",
		version: 1,
		created_at: "2026-02-11T12:00:00.000Z",
		updated_at: "2026-02-11T12:00:00.000Z",
		tools_required: ["odoo-toolbox", "go-easy"],
		steps: [],
		...overrides,
	};
}

describe("parsePlan step parsing", () => {
	it("parses 1 step", () => {
		const plan = makePlan({
			steps: [
				{ description: "Read invoice", tool: "odoo-toolbox", operation: "read", target: "INV-001" },
			],
		});
		const serialized = serializePlan(plan);
		const parsed = parsePlan(serialized);
		expect(parsed.steps).toHaveLength(1);
		expect(parsed.steps[0].description).toBe("Read invoice");
		expect(parsed.steps[0].target).toBe("INV-001");
	});

	it("parses 2 steps without losing the second", () => {
		const plan = makePlan({
			steps: [
				{ description: "Search for test partner in Odoo", tool: "odoo-toolbox", operation: "search", target: "res.partner" },
				{ description: "Send test notification email", tool: "go-easy", operation: "send", target: "test@example.com" },
			],
		});
		const serialized = serializePlan(plan);
		const parsed = parsePlan(serialized);
		expect(parsed.steps).toHaveLength(2);
		expect(parsed.steps[0].description).toBe("Search for test partner in Odoo");
		expect(parsed.steps[0].tool).toBe("odoo-toolbox");
		expect(parsed.steps[1].description).toBe("Send test notification email");
		expect(parsed.steps[1].tool).toBe("go-easy");
		expect(parsed.steps[1].target).toBe("test@example.com");
	});

	it("parses 5 steps", () => {
		const plan = makePlan({
			steps: [
				{ description: "Step one", tool: "toolA", operation: "op1" },
				{ description: "Step two", tool: "toolB", operation: "op2" },
				{ description: "Step three", tool: "toolC", operation: "op3", target: "tgt3" },
				{ description: "Step four", tool: "toolD", operation: "op4" },
				{ description: "Step five", tool: "toolE", operation: "op5", target: "tgt5" },
			],
		});
		const serialized = serializePlan(plan);
		const parsed = parsePlan(serialized);
		expect(parsed.steps).toHaveLength(5);
		expect(parsed.steps[0].description).toBe("Step one");
		expect(parsed.steps[2].target).toBe("tgt3");
		expect(parsed.steps[4].description).toBe("Step five");
		expect(parsed.steps[4].target).toBe("tgt5");
	});

	it("parses steps with context section following", () => {
		const plan = makePlan({
			steps: [
				{ description: "Read data", tool: "odoo-toolbox", operation: "read" },
				{ description: "Send email", tool: "go-easy", operation: "send" },
			],
			context: "Invoice is overdue by 30 days.",
		});
		const serialized = serializePlan(plan);
		const parsed = parsePlan(serialized);
		expect(parsed.steps).toHaveLength(2);
		expect(parsed.context).toBe("Invoice is overdue by 30 days.");
	});

	it("parses 0 steps (empty plan)", () => {
		const plan = makePlan({ steps: [] });
		const serialized = serializePlan(plan);
		const parsed = parsePlan(serialized);
		expect(parsed.steps).toHaveLength(0);
	});
});

describe("multi-step roundtrip through serialize → parse → serialize", () => {
	it("preserves all steps through double roundtrip", () => {
		const original = makePlan({
			steps: [
				{ description: "Search for test partner in Odoo", tool: "odoo-toolbox", operation: "search", target: "res.partner" },
				{ description: "Send test notification email", tool: "go-easy", operation: "send", target: "test@example.com" },
				{ description: "Update partner status", tool: "odoo-toolbox", operation: "write", target: "res.partner" },
			],
			context: "Testing multi-step plan.",
		});

		// First roundtrip
		const s1 = serializePlan(original);
		const p1 = parsePlan(s1);
		expect(p1.steps).toHaveLength(3);

		// Second roundtrip (simulates what approve() does: read → parse → modify → serialize)
		p1.status = "approved";
		p1.version++;
		const s2 = serializePlan(p1);
		const p2 = parsePlan(s2);

		expect(p2.steps).toHaveLength(3);
		expect(p2.steps[0].description).toBe("Search for test partner in Odoo");
		expect(p2.steps[1].description).toBe("Send test notification email");
		expect(p2.steps[2].description).toBe("Update partner status");
		expect(p2.status).toBe("approved");
		expect(p2.version).toBe(2);
		expect(p2.context).toBe("Testing multi-step plan.");
	});

	it("preserves steps through triple roundtrip (approve → execute → complete)", () => {
		const original = makePlan({
			steps: [
				{ description: "Fetch invoice", tool: "odoo-toolbox", operation: "read", target: "INV-2024-0847" },
				{ description: "Send reminder", tool: "go-easy", operation: "send" },
			],
		});

		// Roundtrip 1: approve
		const p1 = parsePlan(serializePlan(original));
		p1.status = "approved";
		p1.version++;

		// Roundtrip 2: mark executing
		const p2 = parsePlan(serializePlan(p1));
		p2.status = "executing";
		p2.version++;
		p2.execution_started_at = "2026-02-11T13:00:00Z";

		// Roundtrip 3: mark completed
		const p3 = parsePlan(serializePlan(p2));
		p3.status = "completed";
		p3.version++;
		p3.result_summary = "All done";

		// Verify final state has all steps intact
		const final = parsePlan(serializePlan(p3));
		expect(final.steps).toHaveLength(2);
		expect(final.steps[0].description).toBe("Fetch invoice");
		expect(final.steps[0].target).toBe("INV-2024-0847");
		expect(final.steps[1].description).toBe("Send reminder");
		expect(final.status).toBe("completed");
		expect(final.version).toBe(4);
	});
});
