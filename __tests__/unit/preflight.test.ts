import { describe, it, expect } from "vitest";
import { validatePreflight } from "../../src/executor/preflight.js";

describe("validatePreflight", () => {
	it("passes for valid approved plan with available tools", () => {
		const result = validatePreflight(
			{ status: "approved", version: 2, tools_required: ["odoo-toolbox", "go-easy"] },
			2,
			["odoo-toolbox", "go-easy", "read", "bash"],
		);
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("fails if plan is not approved", () => {
		const result = validatePreflight(
			{ status: "proposed", version: 1, tools_required: [] },
			1,
			[],
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("proposed");
		expect(result.error).toContain("approved");
	});

	it("fails on version mismatch", () => {
		const result = validatePreflight(
			{ status: "approved", version: 3, tools_required: [] },
			2,
			[],
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("v2");
		expect(result.error).toContain("v3");
	});

	it("fails if required tools are missing", () => {
		const result = validatePreflight(
			{ status: "approved", version: 2, tools_required: ["odoo-toolbox", "missing-tool"] },
			2,
			["odoo-toolbox", "read", "bash"],
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("missing-tool");
	});

	it("passes with empty tools_required", () => {
		const result = validatePreflight(
			{ status: "approved", version: 1, tools_required: [] },
			1,
			["read", "bash"],
		);
		expect(result.ok).toBe(true);
	});

	it("fails if executing (not approved)", () => {
		const result = validatePreflight(
			{ status: "executing", version: 3, tools_required: [] },
			3,
			[],
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("executing");
	});
});
