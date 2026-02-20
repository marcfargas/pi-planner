import { describe, it, expect } from "vitest";
import { buildExecutorPrompt, renderPlanForExecutor } from "../../src/executor/runner.js";
import type { Plan } from "../../src/persistence/types.js";

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		id: "PLAN-deadbeef",
		title: "Test plan",
		status: "approved",
		version: 2,
		created_at: "2026-02-11T12:00:00Z",
		updated_at: "2026-02-11T12:05:00Z",
		tools_required: ["odoo-toolbox", "go-easy"],
		steps: [
			{ description: "Read invoice", tool: "odoo-toolbox", operation: "read", target: "INV-2024-0847" },
			{ description: "Send reminder", tool: "go-easy", operation: "send" },
		],
		...overrides,
	};
}

describe("buildExecutorPrompt", () => {
	it("includes plan title", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("Test plan");
	});

	it("lists tools", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("odoo-toolbox, go-easy");
	});

	it("includes steps with numbering", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("1. Read invoice");
		expect(prompt).toContain("2. Send reminder");
	});

	it("includes target when present", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("→ INV-2024-0847");
	});

	it("includes context when present", () => {
		const prompt = buildExecutorPrompt(makePlan({ context: "Invoice overdue 30 days." }));
		expect(prompt).toContain("## Context");
		expect(prompt).toContain("Invoice overdue 30 days.");
	});

	it("omits context section when not present", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).not.toContain("## Context");
	});

	it("contains safety rules", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("STOP immediately");
		expect(prompt).toContain("Do NOT improvise");
		expect(prompt).toContain("Do NOT use bash");
	});

	it("includes plan_run_script execution protocol", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("plan_run_script");
		expect(prompt).toContain("step_complete");
		expect(prompt).toContain("step_failed");
		expect(prompt).toContain("plan_complete");
		expect(prompt).toContain("plan_failed");
	});

	it("includes plan ID", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).toContain("PLAN-deadbeef");
	});

	it("includes executor model when present", () => {
		const prompt = buildExecutorPrompt(makePlan({ executor_model: "anthropic/claude-sonnet-4" }));
		expect(prompt).toContain("## Executor Model");
		expect(prompt).toContain("anthropic/claude-sonnet-4");
	});

	it("omits executor model section when not present", () => {
		const prompt = buildExecutorPrompt(makePlan());
		expect(prompt).not.toContain("## Executor Model");
	});
});

describe("renderPlanForExecutor", () => {
	it("includes plan ID and title", () => {
		const task = renderPlanForExecutor(makePlan());
		expect(task).toContain("PLAN-deadbeef");
		expect(task).toContain("Test plan");
	});
});
