/**
 * pi-planner: plan lifecycle via harness.
 *
 * Tests: propose → get → approve → reject, and plan_run_script reporting.
 * All through the real extension running in a real AgentSession.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { createTestSession, when, calls, says, type TestSession } from "@marcfargas/pi-test-harness";

const EXTENSION_PATH = path.resolve(__dirname, "../../src/index.ts");

const MOCKS = {
	bash: (params: Record<string, unknown>) => `mock: ${params.command}`,
	read: "mock contents",
	write: "mock written",
	edit: "mock edited",
};

describe("pi-planner: plan lifecycle via harness", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("propose → get → shows plan details", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose and get plan", [
				calls("plan_propose", {
					title: "Send invoice reminder",
					steps: [
						{ description: "Read invoice", tool: "odoo", operation: "read", target: "INV-001" },
						{ description: "Send email", tool: "go-easy", operation: "send" },
					],
					context: "Invoice overdue by 30 days",
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_get", () => ({ id: planId })),
				says("Plan details retrieved."),
			]),
		);

		// plan_get should return full plan details
		const getResult = t.events.toolResultsFor("plan_get");
		expect(getResult).toHaveLength(1);
		expect(getResult[0].text).toContain("Send invoice reminder");
		expect(getResult[0].text).toContain("Read invoice");
		expect(getResult[0].text).toContain("Send email");
		expect(getResult[0].text).toContain("odoo");
		expect(getResult[0].text).toContain("Invoice overdue");
	});

	it("propose → approve starts execution", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose and approve plan", [
				calls("plan_propose", {
					title: "Deploy to staging",
					steps: [
						{ description: "Build project", tool: "bash", operation: "build" },
					],
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_approve", () => ({ id: planId })),
				says("Plan approved."),
			]),
		);

		const approveResult = t.events.toolResultsFor("plan_approve");
		expect(approveResult).toHaveLength(1);
		expect(approveResult[0].text).toContain("approved");
		expect(approveResult[0].text).toContain("execution started");
		expect(approveResult[0].isError).toBe(false);
	});

	it("propose → reject with feedback", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose and reject plan", [
				calls("plan_propose", {
					title: "Delete database",
					steps: [
						{ description: "Drop tables", tool: "odoo", operation: "write" },
					],
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_reject", () => ({ id: planId, feedback: "Too dangerous, needs review" })),
				says("Plan rejected."),
			]),
		);

		const rejectResult = t.events.toolResultsFor("plan_reject");
		expect(rejectResult).toHaveLength(1);
		expect(rejectResult[0].text).toContain("rejected");
		expect(rejectResult[0].text).toContain("Too dangerous");
	});

	it("plan_list shows proposed plans", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Create two plans and list", [
				calls("plan_propose", {
					title: "First plan",
					steps: [{ description: "Step 1", tool: "bash", operation: "run" }],
				}),
				calls("plan_propose", {
					title: "Second plan",
					steps: [{ description: "Step A", tool: "go-easy", operation: "send" }],
				}),
				calls("plan_list", {}),
				says("Plans listed."),
			]),
		);

		const listResult = t.events.toolResultsFor("plan_list");
		expect(listResult).toHaveLength(1);
		expect(listResult[0].text).toContain("First plan");
		expect(listResult[0].text).toContain("Second plan");
		expect(listResult[0].text).toContain("proposed");
	});

	it("plan_list with status filter", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Create, reject one, list proposed", [
				calls("plan_propose", {
					title: "Kept plan",
					steps: [{ description: "Step", tool: "bash", operation: "run" }],
				}),
				calls("plan_propose", {
					title: "Rejected plan",
					steps: [{ description: "Step", tool: "bash", operation: "run" }],
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_reject", () => ({ id: planId })),
				calls("plan_list", { status: "proposed" }),
				says("Filtered list."),
			]),
		);

		const listResult = t.events.toolResultsFor("plan_list");
		expect(listResult).toHaveLength(1);
		expect(listResult[0].text).toContain("Kept plan");
		expect(listResult[0].text).not.toContain("Rejected plan");
	});

	it("plan_get for non-existent plan returns error", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Get non-existent plan", [
				calls("plan_get", { id: "PLAN-00000000" }),
				says("Not found."),
			]),
		);

		const getResult = t.events.toolResultsFor("plan_get");
		expect(getResult).toHaveLength(1);
		expect(getResult[0].isError).toBe(true);
		expect(getResult[0].text).toContain("not found");
	});

	it("approve non-existent plan returns error", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Approve non-existent", [
				calls("plan_approve", { id: "PLAN-00000000" }),
				says("Failed."),
			]),
		);

		const result = t.events.toolResultsFor("plan_approve");
		expect(result).toHaveLength(1);
		expect(result[0].isError).toBe(true);
	});
});

describe("pi-planner: plan_approve executor prompt", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("approve includes executor prompt with plan_run_script protocol", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose and approve", [
				calls("plan_propose", {
					title: "Build and deploy",
					steps: [
						{ description: "Build project", tool: "bash", operation: "build" },
						{ description: "Run tests", tool: "bash", operation: "test" },
					],
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_approve", () => ({ id: planId })),
				says("I'll follow the plan."),
			]),
		);

		const approveResult = t.events.toolResultsFor("plan_approve");
		expect(approveResult).toHaveLength(1);
		const resultText = approveResult[0].text;

		// The approve result should include the executor prompt inline
		expect(resultText).toContain("approved and execution started");
		expect(resultText).toContain("plan_run_script");
		expect(resultText).toContain("step_complete");
		expect(resultText).toContain("plan_complete");
		expect(resultText).toContain("Build and deploy");
		expect(resultText).toContain("Build project");
		expect(resultText).toContain("Run tests");
	});
});

describe("pi-planner: plan_run_script via harness", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("plan_run_script without active execution returns error", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Try to report without execution", [
				calls("plan_run_script", {
					action: "step_complete",
					step: 1,
					summary: "Did something",
				}),
				says("No active execution."),
			]),
		);

		const result = t.events.toolResultsFor("plan_run_script");
		expect(result).toHaveLength(1);
		expect(result[0].isError).toBe(true);
		expect(result[0].text).toContain("No active plan execution");
	});
});
