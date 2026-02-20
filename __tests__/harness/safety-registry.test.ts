/**
 * pi-planner: skill safety registry via harness.
 *
 * Tests plan_skill_safety tool + integration with plan mode bash filtering.
 * The safety registry allows READ operations in plan mode while blocking WRITE.
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

describe("pi-planner: safety registry via harness", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("registers safety patterns via plan_skill_safety", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Register safety patterns", [
				calls("plan_skill_safety", {
					tool: "go-gmail",
					commands: {
						"npx go-gmail * search *": "READ",
						"npx go-gmail * get *": "READ",
						"npx go-gmail * send *": "WRITE",
						"npx go-gmail * draft *": "WRITE",
					},
					default: "WRITE",
				}),
				says("Patterns registered."),
			]),
		);

		const result = t.events.toolResultsFor("plan_skill_safety");
		expect(result).toHaveLength(1);
		expect(result[0].text).toContain("Registered 4 safety pattern(s)");
		expect(result[0].text).toContain("go-gmail");
		expect(result[0].isError).toBe(false);
	});

	it("READ commands allowed in plan mode after safety registration", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Register safety then use READ in plan mode", [
				calls("plan_skill_safety", {
					tool: "go-gmail",
					commands: {
						"npx go-gmail * search *": "READ",
						"npx go-gmail * send *": "WRITE",
					},
					default: "WRITE",
				}),
				calls("plan_mode", { enable: true }),
				// This should be ALLOWED — it's a READ operation
				calls("bash", { command: "npx go-gmail marc@test.com search 'invoice'" }),
				says("Search succeeded in plan mode."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
		expect(bashResults[0].isError).toBe(false);
		expect(bashResults[0].text).toContain("npx go-gmail");
	});

	it("WRITE commands blocked in plan mode after safety registration", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Register safety then use WRITE in plan mode", [
				calls("plan_skill_safety", {
					tool: "go-gmail",
					commands: {
						"npx go-gmail * search *": "READ",
						"npx go-gmail * send *": "WRITE",
					},
					default: "WRITE",
				}),
				calls("plan_mode", { enable: true }),
				// This should be BLOCKED — it's a WRITE operation
				calls("bash", { command: "npx go-gmail marc@test.com send --to bob@test.com" }),
				says("Send was blocked."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
		expect(bashResults[0].isError).toBe(true);
		expect(bashResults[0].text).toContain("WRITE operation blocked");
	});

	it("multiple tool registrations work together", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Register multiple tools", [
				calls("plan_skill_safety", {
					tool: "go-gmail",
					commands: { "npx go-gmail * search *": "READ" },
					default: "WRITE",
				}),
				calls("plan_skill_safety", {
					tool: "gcloud",
					commands: { "gcloud * list *": "READ", "gcloud * describe *": "READ" },
					default: "WRITE",
				}),
				calls("plan_mode", { enable: true }),
				// Gmail search: READ → allowed
				calls("bash", { command: "npx go-gmail marc search 'test'" }),
				// gcloud list: READ → allowed (trailing flag needed for "* list *" glob)
				calls("bash", { command: "gcloud compute instances list --format=json" }),
				says("Both READ operations worked."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(2);
		expect(bashResults[0].isError).toBe(false);
		expect(bashResults[1].isError).toBe(false);
	});

	it("unregistered command falls through to allowlist", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Register safety then run unregistered command", [
				calls("plan_skill_safety", {
					tool: "go-gmail",
					commands: { "npx go-gmail * search *": "READ" },
					default: "WRITE",
				}),
				calls("plan_mode", { enable: true }),
				// "ls" is not in the safety registry → falls through to allowlist → allowed
				calls("bash", { command: "ls -la" }),
				// "curl" is in the allowlist → allowed
				calls("bash", { command: "curl https://example.com" }),
				says("Unregistered commands handled by allowlist."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(2);
		expect(bashResults[0].isError).toBe(false); // ls allowed by allowlist
		expect(bashResults[1].isError).toBe(false); // curl allowed by allowlist
	});
});

describe("pi-planner: tool sequence verification", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	it("full plan mode workflow has correct tool sequence", async () => {
		t = await createTestSession({
			extensions: [EXTENSION_PATH],
			mockTools: MOCKS,
		});

		await t.run(
			when("Full plan mode workflow", [
				calls("plan_mode", { enable: true }),
				calls("bash", { command: "ls" }),
				calls("plan_propose", {
					title: "Test plan",
					steps: [{ description: "Do thing", tool: "bash", operation: "run" }],
				}),
				calls("plan_list", {}),
				calls("plan_mode", { enable: false }),
				says("Workflow complete."),
			]),
		);

		expect(t.events.toolSequence()).toEqual([
			"plan_mode",
			"bash",
			"plan_propose",
			"plan_list",
			"plan_mode",
		]);
	});
});
