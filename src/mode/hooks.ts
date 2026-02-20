/**
 * Mode switching and tool_call hooks.
 *
 * - before_agent_start: injects plan-mode context + skill safety extraction instruction
 * - tool_call: blocks destructive bash in plan mode, with safety registry override
 *   for skill operations classified as READ
 *
 * Phase C will upgrade tool_call to enforcement mode for executor agents.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PlanStore } from "../persistence/plan-store.js";
import type { SafetyRegistry } from "@marcfargas/pi-safety";

export type PlannerMode = "plan" | "normal";

/**
 * Tools blocked in plan mode (beyond bash filtering).
 * setActiveTools() only hides tools from the prompt — it doesn't prevent execution.
 * This list is the enforcement layer.
 */
const PLAN_MODE_BLOCKED_TOOLS = new Set([
	"write", "edit",
	// subagent tools that could modify state
	"todo",
]);

/**
 * Safe bash commands allowed in plan mode.
 * Everything else is blocked.
 */
const SAFE_BASH_PATTERNS: RegExp[] = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*rg\b/, /^\s*find\b/, /^\s*fd\b/,
	/^\s*ls\b/, /^\s*exa\b/, /^\s*tree\b/,
	/^\s*pwd\b/, /^\s*echo\b/, /^\s*printf\b/,
	/^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
	/^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/,
	/^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/,
	/^\s*env\b/, /^\s*printenv\b/,
	/^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/,
	/^\s*ps\b/, /^\s*uptime\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*node\s+--version/i, /^\s*python\s+--version/i,
	/^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/, /^\s*bat\b/,
	/^\s*curl\s/i,
];

/**
 * Destructive commands that are always blocked in plan mode,
 * even if they look like they'd match a safe pattern.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i, /\brmdir\b/i, /\bmv\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick)/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\bsudo\b/i, /\bkill\b/i, /\bpkill\b/i,
];

/**
 * Check if a command contains dangerous redirects (file writes via > or >>).
 * Allows safe patterns: 2>/dev/null, 2>&1, >/dev/null
 */
export function hasDangerousRedirect(command: string): boolean {
	// Strip safe redirect patterns before checking
	const cleaned = command
		.replace(/\d*>\s*\/dev\/null/g, "")   // N>/dev/null
		.replace(/\d*>&\d+/g, "")              // N>&M (e.g., 2>&1)
		.replace(/&>\s*\/dev\/null/g, "");     // &>/dev/null
	// Check for remaining redirects
	return /(?:^|[^<])>/.test(cleaned);
}

export function isSafeBashCommand(command: string): boolean {
	// Check explicit destructive patterns first
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	if (isDestructive) return false;
	// Check for dangerous redirects (> or >> writing to files, but not 2>/dev/null etc.)
	if (hasDangerousRedirect(command)) return false;
	return SAFE_BASH_PATTERNS.some((p) => p.test(command));
}

export function registerModeHooks(
	pi: ExtensionAPI,
	getStore: (cwd: string) => PlanStore,
	getGuardedTools: () => string[],
	getMode: () => PlannerMode,
	getRegistry: () => SafetyRegistry,
): void {
	// before_agent_start: inject plan-mode awareness + skill safety extraction instruction
	pi.on("before_agent_start", async (_event, ctx) => {
		const store = getStore(ctx.cwd);
		const mode = getMode();

		// Check for pending plans to surface
		const proposed = await store.list({ status: "proposed" });
		const executing = await store.list({ status: "executing" });

		const parts: string[] = [];

		if (mode === "plan") {
			parts.push(
				"[PLAN MODE ACTIVE] You are in plan mode — read-only exploration + plan tools only.",
				"You CANNOT use: edit, write (file modifications are disabled).",
				"Bash is restricted to read-only commands (but READ operations from skills with safety classifications are allowed — see SKILL SAFETY below).",
				"Use plan_propose to create plans for actions that need approval.",
			);
		}

		if (proposed.length > 0) {
			parts.push(
				`[PLAN MODE] ${proposed.length} plan(s) awaiting approval:`,
				...proposed.map((p) => `  - ${p.id}: ${p.title}`),
			);
		}

		if (executing.length > 0) {
			parts.push(
				`[PLAN MODE] ${executing.length} plan(s) currently executing:`,
				...executing.map((p) => `  - ${p.id}: ${p.title} (started ${p.execution_started_at})`),
			);
		}

		// Check for stalled plans (executing > timeout)
		const guardedToolsList = getGuardedTools();
		if (guardedToolsList.length > 0) {
			parts.push(
				`[PLAN MODE] Guarded tools (require a plan): ${guardedToolsList.join(", ")}`,
			);
		}

		// Skill safety extraction instruction — always injected so the registry
		// populates regardless of when skills are loaded relative to plan mode.
		parts.push(
			"",
			"[SKILL SAFETY] When you read (load) a skill that classifies operations with safety levels",
			"(e.g., READ, WRITE, DESTRUCTIVE, EXPENSIVE, SECURITY, FORBIDDEN), extract those classifications",
			"and call plan_skill_safety with command-matching glob patterns.",
			"",
			"Use glob patterns that match how the CLI is actually invoked in bash.",
			"Use * as wildcard. Patterns must start with the tool/CLI name (or a runner prefix like npx).",
			"Collapse all non-READ levels to WRITE. Only READ and WRITE are valid.",
			"If in doubt, classify as WRITE.",
			"",
			"Example:",
			"  plan_skill_safety({",
			"    tool: \"go-gmail\",",
			"    commands: {",
			"      \"npx go-gmail * search *\": \"READ\",",
			"      \"npx go-gmail * get *\": \"READ\",",
			"      \"npx go-gmail * thread *\": \"READ\",",
			"      \"npx go-gmail * send *\": \"WRITE\",",
			"      \"npx go-gmail * draft *\": \"WRITE\"",
			"    },",
			"    default: \"WRITE\"",
			"  })",
			"",
			"Call once per tool/CLI after reading its skill documentation.",
		);

		// Show current registry state so agent knows what's already registered
		const registry = getRegistry();
		if (registry.size > 0) {
			const entries = registry.inspect();
			parts.push(
				"",
				`[SKILL SAFETY] Currently registered: ${entries.map((e) => `${e.tool} (${e.patterns} patterns)`).join(", ")}`,
			);
		}

		if (parts.length === 0) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: parts.join("\n"),
				display: false,
			},
		};
	});

	// tool_call hook:
	// 1. In plan mode: block write/edit and destructive bash commands
	// 2. Phase A guarded tools: log but don't block
	pi.on("tool_call", async (event, ctx) => {
		const mode = getMode();

		// Plan mode: block write/edit and other state-modifying tools
		if (mode === "plan" && PLAN_MODE_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: "${event.toolName}" is blocked (read-only mode). Exit plan mode first with plan_mode(enable: false).`,
			};
		}

		// Plan mode: filter bash commands through safety registry, then existing allowlist
		if (mode === "plan" && event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";

			// Check safety registry first — skills that reported their safety levels
			// get intelligent filtering (READ operations allowed, WRITE blocked)
			const registry = getRegistry();
			const registryLevel = registry.resolve(command);

			if (registryLevel === "READ") {
				// Registry says READ — allow this command in plan mode
				return undefined;
			}

			if (registryLevel === "WRITE") {
				// Registry says WRITE — block with informative message
				return {
					block: true,
					reason: `Plan mode: WRITE operation blocked (per skill safety registry). Propose a plan for this action.\nCommand: ${command}`,
				};
			}

			// No registry match — fall through to existing allowlist/denylist
			if (!isSafeBashCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not allowlisted). Use /plan to exit plan mode first.\nCommand: ${command}`,
				};
			}
		}

		// Guarded tools logging (Phase A — log only, don't block)
		const guardedToolsList = getGuardedTools();
		if (guardedToolsList.length === 0) return;

		const toolName = event.toolName;
		const isGuarded = guardedToolsList.some((g) => toolName === g || toolName.startsWith(`${g}_`));
		if (!isGuarded) return;

		// Check if there's an active plan
		const store = getStore(ctx.cwd);
		const executingPlans = await store.list({ status: "executing" });
		const hasActivePlan = executingPlans.length > 0;

		if (!hasActivePlan) {
			// Log that a guarded tool was called without an active plan
			console.error(
				`[pi-planner] GUARDED TOOL CALL without plan: ${toolName} (input: ${JSON.stringify(event.input).slice(0, 200)})`,
			);
			// Phase C: return { block: true, reason: `Tool "${toolName}" requires an approved plan. Use plan_propose first.` };
		}

		return undefined;
	});

	// Filter stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		const mode = getMode();
		if (mode === "plan") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as any;
				if (msg.customType === "plan-mode-context" && typeof msg.content === "string") {
					return !msg.content.includes("[PLAN MODE ACTIVE]");
				}
				return true;
			}),
		};
	});
}
