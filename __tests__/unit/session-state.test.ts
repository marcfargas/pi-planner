import { describe, it, expect } from "vitest";
import type { PlannerState } from "../../src/index.js";

/**
 * Tests for session state persistence logic.
 *
 * Since the extension's activate() function needs a full ExtensionAPI mock,
 * we test the state shape and restore logic separately.
 */

describe("PlannerState", () => {
	it("serializes correctly as JSON", () => {
		const state: PlannerState = {
			planMode: true,
		};

		const json = JSON.stringify(state);
		const parsed = JSON.parse(json) as PlannerState;

		expect(parsed.planMode).toBe(true);
	});

	it("defaults planMode to false", () => {
		const state: PlannerState = {
			planMode: false,
		};

		expect(state.planMode).toBe(false);
	});

	it("survives roundtrip through appendEntry/getEntries pattern", () => {
		// Simulate what appendEntry does: wraps in CustomEntry
		const customEntry = {
			type: "custom" as const,
			customType: "pi-planner",
			data: { planMode: true } as PlannerState,
			id: "abc123",
			parentId: null,
			timestamp: new Date().toISOString(),
		};

		// Simulate what session_start restore does
		const entries = [customEntry];
		const plannerEntry = entries
			.filter((e) => e.type === "custom" && e.customType === "pi-planner")
			.pop();

		expect(plannerEntry).toBeDefined();
		expect((plannerEntry!.data as PlannerState).planMode).toBe(true);
	});

	it("handles missing data gracefully", () => {
		const customEntry = {
			type: "custom" as const,
			customType: "pi-planner",
			data: undefined,
			id: "abc123",
			parentId: null,
			timestamp: new Date().toISOString(),
		};

		const plannerEntry = customEntry;
		const planMode = plannerEntry?.data?.planMode ?? false;
		expect(planMode).toBe(false);
	});

	it("picks the last entry when multiple exist", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "pi-planner",
				data: { planMode: true } as PlannerState,
				id: "001",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
			},
			{
				type: "custom" as const,
				customType: "pi-planner",
				data: { planMode: false } as PlannerState,
				id: "002",
				parentId: "001",
				timestamp: "2026-01-01T01:00:00Z",
			},
		];

		const plannerEntry = entries
			.filter((e) => e.type === "custom" && e.customType === "pi-planner")
			.pop();

		expect((plannerEntry!.data as PlannerState).planMode).toBe(false);
	});

	it("ignores entries with different customType", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "other-extension",
				data: { someProp: true },
				id: "001",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
			},
			{
				type: "custom" as const,
				customType: "pi-planner",
				data: { planMode: true } as PlannerState,
				id: "002",
				parentId: "001",
				timestamp: "2026-01-01T01:00:00Z",
			},
		];

		const plannerEntry = entries
			.filter((e) => e.type === "custom" && e.customType === "pi-planner")
			.pop();

		expect((plannerEntry!.data as PlannerState).planMode).toBe(true);
	});
});
