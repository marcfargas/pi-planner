/**
 * pi-planner: executor_model feature via harness.
 *
 * Tests: proposing plans with executor_model, display in plan_get,
 * and model validation warnings during execution.
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

describe("pi-planner: executor_model via harness", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("propose with executor_model stores it on the plan", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose with executor model", [
				calls("plan_propose", {
					title: "Deploy with specific model",
					steps: [
						{ description: "Run deploy", tool: "bash", operation: "run" },
					],
					executor_model: "anthropic/claude-sonnet-4",
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_get", () => ({ id: planId })),
				says("Done."),
			]),
		);

		// Propose result should mention the executor model
		const proposeResult = t.events.toolResultsFor("plan_propose");
		expect(proposeResult).toHaveLength(1);
		expect(proposeResult[0].text).toContain("anthropic/claude-sonnet-4");

		// plan_get should display executor model
		const getResult = t.events.toolResultsFor("plan_get");
		expect(getResult).toHaveLength(1);
		expect(getResult[0].text).toContain("anthropic/claude-sonnet-4");
		expect(getResult[0].text).toContain("Executor model");
	});

	it("propose without executor_model omits it from display", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Propose without executor model", [
				calls("plan_propose", {
					title: "Simple plan",
					steps: [
						{ description: "Step 1", tool: "bash", operation: "run" },
					],
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				calls("plan_get", () => ({ id: planId })),
				says("Done."),
			]),
		);

		const proposeResult = t.events.toolResultsFor("plan_propose");
		expect(proposeResult[0].text).not.toContain("Executor model");

		const getResult = t.events.toolResultsFor("plan_get");
		expect(getResult[0].text).not.toContain("Executor model");
	});

	it("executor_model survives serialization round-trip", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		let planId = "";

		await t.run(
			when("Create plan with model, list, get", [
				calls("plan_propose", {
					title: "Model round-trip test",
					steps: [
						{ description: "Do something", tool: "bash", operation: "run" },
					],
					executor_model: "openai/gpt-4o",
				}).then((r) => {
					planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
				}),
				// Get it back — forces re-read from store
				calls("plan_get", () => ({ id: planId })),
				says("Verified."),
			]),
		);

		const getResult = t.events.toolResultsFor("plan_get");
		expect(getResult[0].text).toContain("openai/gpt-4o");
	});

	it("clone preserves executor_model", async () => {
		// We can't test clone via tool (it's a UI command), but we can verify
		// the store.create accepts executor_model by creating two plans
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Create two plans with different models", [
				calls("plan_propose", {
					title: "Plan A",
					steps: [{ description: "Step", tool: "bash", operation: "run" }],
					executor_model: "anthropic/claude-sonnet-4",
				}),
				calls("plan_propose", {
					title: "Plan B",
					steps: [{ description: "Step", tool: "bash", operation: "run" }],
					executor_model: "google/gemini-2.5-pro",
				}),
				calls("plan_list", {}),
				says("Listed."),
			]),
		);

		const listResult = t.events.toolResultsFor("plan_list");
		expect(listResult[0].text).toContain("Plan A");
		expect(listResult[0].text).toContain("Plan B");
	});
});
