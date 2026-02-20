import { describe, it, expect, beforeEach } from "vitest";
import { isSafeBashCommand } from "../../src/mode/hooks.js";
import { SafetyRegistry } from "@marcfargas/pi-safety";

/**
 * Tests for how the safety registry integrates with plan mode bash filtering.
 *
 * The actual tool_call hook flow is:
 *   1. Check registry → READ = allow, WRITE = block
 *   2. No match → fall through to isSafeBashCommand()
 *
 * These tests verify the resolution logic without mocking the full pi extension API.
 */

describe("safety registry + plan mode integration", () => {
	let registry: SafetyRegistry;

	/** Simulates the tool_call hook logic for bash in plan mode. */
	function planModeBashDecision(command: string): "allow" | "block-registry" | "block-allowlist" | "allow-allowlist" {
		const level = registry.resolve(command);
		if (level === "READ") return "allow";
		if (level === "WRITE") return "block-registry";
		// Fall through to existing allowlist
		return isSafeBashCommand(command) ? "allow-allowlist" : "block-allowlist";
	}

	beforeEach(() => {
		registry = new SafetyRegistry();

		// Register go-easy Gmail patterns (as the agent would after reading the skill)
		registry.register("go-gmail", {
			"npx go-gmail * search *": "READ",
			"npx go-gmail * get *": "READ",
			"npx go-gmail * thread *": "READ",
			"npx go-gmail * labels": "READ",
			"npx go-gmail * profile": "READ",
			"npx go-gmail * send *": "WRITE",
			"npx go-gmail * reply *": "WRITE",
			"npx go-gmail * draft *": "WRITE",
			"npx go-gmail * forward *": "WRITE",
		});

		// Register gcloud patterns
		registry.register("gcloud", {
			"gcloud * list *": "READ",
			"gcloud * describe *": "READ",
			"gcloud * get *": "READ",
			"gcloud config *": "READ",
			"gcloud services list *": "READ",
			"gcloud * create *": "WRITE",
			"gcloud * deploy *": "WRITE",
			"gcloud * delete *": "WRITE",
		});
	});

	describe("skill READ operations allowed in plan mode", () => {
		const readOps = [
			// Gmail
			"npx go-gmail marc@blegal.eu search \"from:client is:unread\"",
			"npx go-gmail marc@blegal.eu get msg123",
			"npx go-gmail marc@blegal.eu thread thread123",
			"npx go-gmail marc@blegal.eu labels",
			"npx go-gmail marc@blegal.eu profile",
			// gcloud
			"gcloud compute instances list --format=json",
			"gcloud run services list --format=json",
			"gcloud run services describe my-svc --region=europe-west1 --format=json",
			"gcloud config get-value project",
		];

		for (const cmd of readOps) {
			it(`allows: ${cmd}`, () => {
				expect(planModeBashDecision(cmd)).toBe("allow");
			});
		}
	});

	describe("skill WRITE operations blocked in plan mode", () => {
		const writeOps = [
			// Gmail
			"npx go-gmail marc@blegal.eu send --to=test@x.com --subject=hi --confirm",
			"npx go-gmail marc@blegal.eu reply msg123 --body-text-file=reply.txt --confirm",
			"npx go-gmail marc@blegal.eu draft --to=test@x.com --subject=draft",
			"npx go-gmail marc@blegal.eu forward msg123 --to=other@x.com",
			// gcloud
			"gcloud run deploy my-svc --image=img:latest --region=europe-west1",
			"gcloud run services delete my-svc --region=europe-west1",
			"gcloud compute instances create my-vm --zone=us-central1-a",
		];

		for (const cmd of writeOps) {
			it(`blocks: ${cmd}`, () => {
				expect(planModeBashDecision(cmd)).toBe("block-registry");
			});
		}
	});

	describe("non-skill commands fall through to existing allowlist", () => {
		const allowedByAllowlist = [
			"cat README.md",
			"ls -la",
			"grep -r 'TODO' src/",
			"git status",
			"git log --oneline",
		];

		for (const cmd of allowedByAllowlist) {
			it(`allows via allowlist: ${cmd}`, () => {
				expect(planModeBashDecision(cmd)).toBe("allow-allowlist");
			});
		}

		const blockedByAllowlist = [
			"rm -rf node_modules",
			"git push origin main",
			"npm install lodash",
			"python script.py",
		];

		for (const cmd of blockedByAllowlist) {
			it(`blocks via allowlist: ${cmd}`, () => {
				expect(planModeBashDecision(cmd)).toBe("block-allowlist");
			});
		}
	});

	describe("unregistered skill commands fall through", () => {
		it("unknown CLI falls through to allowlist", () => {
			// go-drive not registered
			expect(planModeBashDecision("npx go-drive marc list")).toBe("block-allowlist");
		});

		it("unknown operation on registered tool blocked by allowlist", () => {
			// "batch-modify" not in go-gmail patterns → falls through to allowlist → blocked
			expect(planModeBashDecision("npx go-gmail marc batch-modify --add=STARRED")).toBe("block-allowlist");
		});
	});

	describe("empty registry falls through to existing behavior", () => {
		it("all commands hit existing allowlist when registry is empty", () => {
			const emptyRegistry = new SafetyRegistry();
			const level = emptyRegistry.resolve("npx go-gmail marc search query");
			expect(level).toBeNull();
		});
	});
});
