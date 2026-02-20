/**
 * pi-planner — Persistent, auditable plan-then-execute workflow for pi agents.
 *
 * Extension entry point. Registers plan tools, commands, and event hooks.
 */

import type { ExtensionAPI, ExtensionContext, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { registerPlanTools } from "./tools/index.js";
import { registerSkillSafetyTool } from "./tools/safety.js";
import { PlanStore } from "./persistence/plan-store.js";
import { loadConfig } from "./persistence/config.js";
import { registerModeHooks, type PlannerMode } from "./mode/hooks.js";
import { executePlan, finishExecution, type ExecutionState } from "./executor/runner.js";
import { findStalledPlans, formatStalledPlanMessage } from "./executor/stalled.js";
import { countCompletedSteps } from "./executor/checkpoint.js";
import { SafetyRegistry } from "@marcfargas/pi-safety";
import { DEFAULT_CONFIG, type Plan, type PlannerConfig } from "./persistence/types.js";

// Read-only tools allowed in plan mode (plus plan CRUD tools added dynamically)
const PLAN_MODE_READONLY = new Set([
	"read", "bash", "grep", "find", "ls",
	"plan_propose", "plan_list", "plan_get", "plan_approve", "plan_reject",
	"plan_mode",
	"plan_skill_safety",
]);

/** State persisted across sessions via appendEntry. */
export interface PlannerState {
	planMode: boolean;
}

const ENTRY_TYPE = "pi-planner";

export default function activate(pi: ExtensionAPI): void {
	// Store and config are initialized lazily on first event (need cwd from ctx)
	let store: PlanStore | undefined;
	let config: PlannerConfig | undefined;
	let configLoaded = false;
	let guardedTools: string[] = [];

	// Extension state
	let planMode = false;
	let allToolNames: string[] | undefined; // snapshot of all tools before entering plan mode

	// Safety registry — populated by agent calling plan_skill_safety
	const safetyRegistry = new SafetyRegistry();

	// Active execution state — one at a time
	let executionState: ExecutionState | null = null;

	function ensureStore(cwd: string): PlanStore {
		if (!store) {
			store = new PlanStore(cwd);
			if (!configLoaded) {
				config = loadConfig(cwd);
				guardedTools = config.guardedTools;
				configLoaded = true;
			}
		}
		return store;
	}

	function getConfig(): PlannerConfig {
		return config ?? DEFAULT_CONFIG;
	}

	function getMode(): PlannerMode {
		return planMode ? "plan" : "normal";
	}

	function persistState(): void {
		const data: PlannerState = { planMode };
		pi.appendEntry(ENTRY_TYPE, data);
	}

	function applyMode(ctx: ExtensionContext): void {
		if (planMode) {
			// Snapshot all tools before restricting (if not already captured)
			if (!allToolNames) {
				allToolNames = pi.getActiveTools();
			}
			// Filter to read-only tools only
			const planTools = allToolNames.filter((t) => PLAN_MODE_READONLY.has(t));
			pi.setActiveTools(planTools);
		} else if (allToolNames) {
			// Restore the full tool set from snapshot
			pi.setActiveTools(allToolNames);
			allToolNames = undefined;
		}
		// If planMode is false and no snapshot exists, don't touch tools at all —
		// this avoids wiping other extensions' tools on session_start.
		updateStatus(ctx);
	}

	async function updateStatus(ctx: ExtensionContext): Promise<void> {
		// Footer status
		if (planMode) {
			ctx.ui.setStatus("pi-planner", "⏸ plan");
		} else if (executionState && !executionState.done) {
			ctx.ui.setStatus("pi-planner", "▶ executing");
		} else {
			ctx.ui.setStatus("pi-planner", undefined);
		}

		// Widget showing pending plans + execution progress
		try {
			const s = store;
			if (!s) return;

			const proposed = await s.list({ status: "proposed" });
			const executing = await s.list({ status: "executing" });

			if (proposed.length > 0 || executing.length > 0) {
				const lines: string[] = [];
				if (proposed.length > 0) {
					lines.push(`📋 ${proposed.length} pending`);
					for (const p of proposed.slice(0, 3)) {
						lines.push(`  ${p.id}: ${p.title}`);
					}
					if (proposed.length > 3) {
						lines.push(`  ... +${proposed.length - 3} more`);
					}
				}
				if (executing.length > 0) {
					for (const p of executing) {
						const completed = countCompletedSteps(ctx.cwd, p.id);
						lines.push(`▶ ${p.id}: ${p.title} (${completed}/${p.steps.length} steps)`);
					}
				}
				ctx.ui.setWidget("pi-planner", lines);
			} else {
				ctx.ui.setWidget("pi-planner", undefined);
			}
		} catch {
			// Don't crash on widget update failure
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planMode = !planMode;

		if (planMode) {
			ctx.ui.notify("Plan mode enabled. Read-only exploration + plan tools.", "info");
		} else {
			ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
		}

		applyMode(ctx);
		persistState();
	}

	/**
	 * Start plan execution in-session.
	 * Called after approval (from tool or command).
	 *
	 * Returns the executor prompt text to include in the tool result,
	 * so the agent can start executing in the same turn (avoiding the
	 * pi agent loop tool-snapshot issue with follow-up messages).
	 */
	async function startExecution(planId: string, ctx: ExtensionContext): Promise<string | undefined> {
		if (executionState && !executionState.done) {
			ctx.ui.notify(`Cannot start ${planId}: another plan is already executing (${executionState.planId}).`, "error");
			return undefined;
		}

		const s = store;
		if (!s) return undefined;

		const plan = await s.get(planId);
		if (!plan || plan.status !== "approved") return undefined;

		// Exit plan mode if active — execution needs full tools
		if (planMode) {
			planMode = false;
			if (allToolNames) {
				pi.setActiveTools(allToolNames);
				allToolNames = undefined;
			}
			persistState();
		}

		// Resolve executor model if specified
		let savedModel: unknown | undefined;
		if (plan.executor_model) {
			const parts = plan.executor_model.split("/");
			if (parts.length === 2) {
				const [provider, modelId] = parts;
				const targetModel = ctx.modelRegistry.find(provider, modelId);
				if (targetModel) {
					savedModel = ctx.model; // snapshot current model
					const switched = await pi.setModel(targetModel);
					if (switched) {
						ctx.ui.notify(`Switched to ${plan.executor_model} for execution.`, "info");
					} else {
						ctx.ui.notify(`No API key for ${plan.executor_model}. Using current model.`, "warning");
						savedModel = undefined; // don't restore if we didn't switch
					}
				} else {
					ctx.ui.notify(`Model ${plan.executor_model} not found. Using current model.`, "warning");
				}
			} else {
				ctx.ui.notify(`Invalid executor_model format "${plan.executor_model}" (expected "provider/model-id"). Using current model.`, "warning");
			}
		}

		const availableToolNames = pi.getAllTools().map((t) => t.name);

		const result = await executePlan(plan, s, ctx.cwd, availableToolNames, ctx, pi, () => updateStatus(ctx));

		if (result.state) {
			result.state.savedModel = savedModel;
			executionState = result.state;
			ctx.ui.notify(`Plan ${planId} execution started. The agent will now follow the plan steps.`, "info");
			await updateStatus(ctx);
			return result.prompt;
		} else {
			// Restore model if execution failed to start
			if (savedModel) {
				try {
					await pi.setModel(savedModel as never);
				} catch { /* best-effort */ }
			}
			ctx.ui.notify(`Plan ${planId} failed to start: ${result.error}`, "error");
			await updateStatus(ctx);
			return undefined;
		}
	}

	// ── Register plan_run_script tool ───────────────────────

	const PlanRunScriptParams = Type.Object({
		action: Type.Union([
			Type.Literal("step_complete"),
			Type.Literal("step_failed"),
			Type.Literal("plan_complete"),
			Type.Literal("plan_failed"),
		], { description: "Report action: step_complete, step_failed, plan_complete, or plan_failed" }),
		step: Type.Optional(Type.Number({ description: "Step number (1-indexed) for step_complete/step_failed" })),
		summary: Type.String({ description: "Description of what happened" }),
	});

	pi.registerTool({
		name: "plan_run_script",
		label: "Plan Run Script",
		description: `Report plan execution progress. Called by the agent during plan execution to report step outcomes.

- step_complete: Report successful completion of a step
- step_failed: Report failure of a step (then call plan_failed)
- plan_complete: Report that all steps completed successfully
- plan_failed: Report that the plan failed (after step_failed, or for plan-level issues)

Always report every step outcome. Always end with exactly one plan_complete or plan_failed.`,
		parameters: PlanRunScriptParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof PlanRunScriptParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			if (!executionState) {
				return {
					content: [{ type: "text", text: "No active plan execution. This tool is only available during plan execution." }],
					details: {},
					isError: true,
				} as AgentToolResult<unknown>;
			}

			const { action, step, summary } = params;
			const state = executionState;

			switch (action) {
				case "step_complete": {
					const stepIdx = (step ?? 1) - 1; // convert to 0-indexed
					state.checkpoint.logStep({
						step: stepIdx,
						tool: state.planId,
						operation: "step_complete",
						status: "success",
						result_summary: summary,
						timestamp: new Date().toISOString(),
					});

					// Update scripts in store
					try {
						await state.store.update(state.planId, (p) => {
							if (p.scripts && p.scripts[stepIdx]) {
								p.scripts[stepIdx].status = "success";
								p.scripts[stepIdx].summary = summary;
							}
						});
					} catch { /* non-fatal */ }

					if (state.onStatusUpdate) await state.onStatusUpdate();

					return {
						content: [{ type: "text", text: `Step ${step} recorded as complete. Continue with the next step.` }],
						details: {},
					} as AgentToolResult<unknown>;
				}

				case "step_failed": {
					const stepIdx = (step ?? 1) - 1;
					state.checkpoint.logStep({
						step: stepIdx,
						tool: state.planId,
						operation: "step_failed",
						status: "failed",
						error: summary,
						timestamp: new Date().toISOString(),
					});

					// Update scripts in store
					try {
						await state.store.update(state.planId, (p) => {
							if (p.scripts && p.scripts[stepIdx]) {
								p.scripts[stepIdx].status = "failed";
								p.scripts[stepIdx].error = summary;
							}
						});
					} catch { /* non-fatal */ }

					if (state.onStatusUpdate) await state.onStatusUpdate();

					return {
						content: [{ type: "text", text: `Step ${step} recorded as failed. Now call plan_run_script with action: "plan_failed".` }],
						details: {},
					} as AgentToolResult<unknown>;
				}

				case "plan_complete": {
					await finishExecution(state, { ok: true, planId: state.planId, error: summary }, pi, ctx);
					ctx.ui.notify(`✓ Plan ${state.planId} completed: ${summary}`, "info");

					return {
						content: [{ type: "text", text: `Plan execution completed successfully. Tools have been restored. Summary: ${summary}` }],
						details: {},
					} as AgentToolResult<unknown>;
				}

				case "plan_failed": {
					await finishExecution(state, { ok: false, planId: state.planId, error: summary }, pi, ctx);
					ctx.ui.notify(`✗ Plan ${state.planId} failed: ${summary}`, "error");

					return {
						content: [{ type: "text", text: `Plan execution failed. Tools have been restored. Error: ${summary}` }],
						details: {},
					} as AgentToolResult<unknown>;
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${action}` }],
						details: {},
						isError: true,
					} as AgentToolResult<unknown>;
			}
		},
	});

	// Register plan tools (with execution callback)
	registerPlanTools(pi, ensureStore, startExecution);

	// Register skill safety tool
	registerSkillSafetyTool(pi, safetyRegistry);

	// plan_mode — agent-callable tool to enter/exit plan mode
	const PlanModeParams = Type.Object({
		enable: Type.Boolean({ description: "true to enter plan mode (read-only + plan tools), false to exit" }),
	});

	pi.registerTool({
		name: "plan_mode",
		label: "Plan Mode",
		description: `Enter or exit plan mode. In plan mode, only read-only tools and plan tools are available — file writes, edits, and destructive bash are blocked.

Enter plan mode when:
- The user asks to plan, prepare, or think through consequential actions
- You need to research before proposing external actions (Odoo, email, calendar, deploys)
- The conversation shifts from "doing" to "planning"

Exit plan mode when:
- The plan is approved/rejected and you need to resume normal work
- The user asks you to do something that requires full tool access
- Planning is done and you're back to development tasks`,
		parameters: PlanModeParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof PlanModeParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const wasInPlanMode = planMode;
			const wantPlanMode = params.enable;

			if (wasInPlanMode === wantPlanMode) {
				return {
					content: [{ type: "text", text: `Already ${wantPlanMode ? "in" : "out of"} plan mode. No change.` }],
					details: {},
				} as AgentToolResult<unknown>;
			}

			togglePlanMode(ctx);

			return {
				content: [{ type: "text", text: wantPlanMode
					? "Plan mode enabled. Read-only exploration + plan tools only. Use plan_propose to create plans."
					: "Plan mode disabled. Full tool access restored." }],
				details: {},
			} as AgentToolResult<unknown>;
		},
	});

	// Register mode hooks (before_agent_start, tool_call logging/blocking)
	registerModeHooks(pi, ensureStore, () => guardedTools, getMode, () => safetyRegistry);

	// /plan — toggle plan mode + manage pending plans
	pi.registerCommand("plan", {
		description: "Toggle plan mode or manage pending plans",
		handler: async (_args, ctx) => {
			const s = ensureStore(ctx.cwd);
			const proposed = await s.list({ status: "proposed" });

			if (proposed.length === 0) {
				togglePlanMode(ctx);
				return;
			}

			const choices = [
				planMode ? "Exit plan mode (restore full access)" : "Enter plan mode (read-only)",
				...proposed.map((p) => `Review: ${p.id} — ${p.title}`),
			];

			const choice = await ctx.ui.select("Plan mode:", choices);
			if (!choice) return;

			if (choice.startsWith("Enter plan mode") || choice.startsWith("Exit plan mode")) {
				togglePlanMode(ctx);
				return;
			}

			const planId = choice.match(/PLAN-[0-9a-f]+/)?.[0];
			if (!planId) return;

			const plan = await s.get(planId);
			if (!plan) return;

			await reviewPlan(plan, s, ctx, startExecution, pi);
			await updateStatus(ctx);
		},
	});

	// /plans — interactive plan browser
	pi.registerCommand("plans", {
		description: "Browse and manage all plans",
		handler: async (_args, ctx) => {
			const s = ensureStore(ctx.cwd);
			const plans = await s.list();

			if (plans.length === 0) {
				ctx.ui.notify("No plans found. Use plan_propose to create one.", "info");
				return;
			}

			const byStatus = new Map<string, Plan[]>();
			for (const p of plans) {
				const group = byStatus.get(p.status) ?? [];
				group.push(p);
				byStatus.set(p.status, group);
			}

			const statusOrder = ["proposed", "approved", "executing", "completed", "failed", "rejected", "cancelled", "stalled"];
			const statusEmoji: Record<string, string> = {
				proposed: "📋", approved: "✅", executing: "▶",
				completed: "✓", failed: "✗", rejected: "⊘",
				cancelled: "—", stalled: "⚠",
			};

			const items: string[] = [];
			for (const status of statusOrder) {
				const group = byStatus.get(status);
				if (!group) continue;
				for (const p of group) {
					const emoji = statusEmoji[p.status] ?? "?";
					items.push(`${emoji} [${p.status}] ${p.id} — ${p.title} (v${p.version})`);
				}
			}

			const choice = await ctx.ui.select(`Plans (${plans.length} total):`, items);
			if (!choice) return;

			const planId = choice.match(/PLAN-[0-9a-f]+/)?.[0];
			if (!planId) return;

			const plan = await s.get(planId);
			if (!plan) return;

			await viewPlanDetail(plan, s, ctx, startExecution, pi);
			await updateStatus(ctx);
		},
	});

	// /safety — inspect the safety registry
	pi.registerCommand("safety", {
		description: "Inspect the skill safety registry",
		handler: async (_args, ctx) => {
			const entries = safetyRegistry.inspect();
			if (entries.length === 0) {
				ctx.ui.notify("Safety registry is empty. No skills have reported safety classifications yet.", "info");
				return;
			}

			const items = entries.map((e) => `${e.tool} (${e.patterns} patterns, default: ${e.default})`);
			const choice = await ctx.ui.select("Registered tools:", items);
			if (!choice) return;

			// Extract tool name from the choice string
			const toolName = choice.split(" (")[0];
			const entry = safetyRegistry.inspectTool(toolName);
			if (!entry) return;

			const lines = [
				`Tool: ${toolName}`,
				`Default: ${entry.default}`,
				`Patterns:`,
				...entry.commands.map((c) => `  ${c.level === "READ" ? "✅" : "❌"} ${c.pattern} → ${c.level}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		ensureStore(ctx.cwd);

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const plannerEntry = entries
			.filter((e) => e.type === "custom" && (e as any).customType === ENTRY_TYPE)
			.pop() as { data?: PlannerState } | undefined;

		if (plannerEntry?.data) {
			planMode = plannerEntry.data.planMode ?? false;
		}

		applyMode(ctx);

		// Check for stalled plans (crash recovery)
		const s = store;
		if (s) {
			const executing = await s.list({ status: "executing" });
			if (executing.length > 0) {
				const cfg = getConfig();
				const stalled = findStalledPlans(executing, cfg.executor_timeout_minutes);

				for (const plan of stalled) {
					await s.update(plan.id, (p) => { p.status = "stalled"; });
					const msg = formatStalledPlanMessage(plan);
					ctx.ui.notify(`⚠ Stalled: ${msg}`, "warning");
				}

				// Plans still executing (not stalled) — notify
				const stillExecuting = executing.filter((p) => !stalled.some((s) => s.id === p.id));
				for (const plan of stillExecuting) {
					ctx.ui.notify(
						`Plan ${plan.id} "${plan.title}" was executing when session ended. Mark as failed? Use /plans to manage.`,
						"warning",
					);
				}
			}
		}
	});

	// Update widget after each agent turn + handle execution completion
	pi.on("agent_end", async (_event, ctx) => {
		// If an execution just finished (plan_run_script set done=true), clean up
		if (executionState?.done) {
			const result = executionState.result;
			executionState = null;

			// Tools already restored by finishExecution in plan_run_script handler
			if (result?.ok) {
				ctx.ui.notify(`Plan ${result.planId} completed successfully.`, "info");
			}
			// Failed notification already shown by plan_run_script handler
		}

		await updateStatus(ctx);
	});
}

// ── Plan Review & Detail Views ──────────────────────────────

type ExecutionStarter = (planId: string, ctx: ExtensionContext) => Promise<string | undefined>;

/**
 * Execute a plan from a slash command context.
 * Unlike tool-based execution, commands can use sendUserMessage
 * since the agent isn't streaming (fresh tool snapshot on next turn).
 */
async function executeFromCommand(
	planId: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	startExecution: ExecutionStarter,
): Promise<void> {
	const prompt = await startExecution(planId, ctx);
	if (prompt) {
		// Send executor prompt — agent will process it in a new turn
		// with a fresh tool snapshot that includes plan_run_script
		pi.sendUserMessage(prompt);
	}
}

async function viewPlanDetail(
	plan: Plan,
	store: PlanStore,
	ctx: ExtensionContext,
	startExecution: ExecutionStarter,
	pi: ExtensionAPI,
): Promise<void> {
	const detail = formatPlanDetail(plan);

	const actions: string[] = [];
	switch (plan.status) {
		case "proposed":
			actions.push("Approve", "Approve & Execute", "Reject", "Delete", "Back");
			break;
		case "approved":
			actions.push("Execute", "Cancel", "Delete", "Back");
			break;
		case "stalled":
			actions.push("Retry", "Mark as Failed", "Clone", "Cancel", "Delete", "Back");
			break;
		case "executing":
			actions.push("Mark as Completed", "Mark as Failed", "Back");
			break;
		case "failed":
			actions.push("Retry", "Clone", "Delete", "Back");
			break;
		case "rejected":
			actions.push("Clone", "Delete", "Back");
			break;
		default:
			// Terminal statuses: completed, cancelled
			actions.push("Clone", "Delete", "Back");
			break;
	}

	const action = await ctx.ui.select(detail, actions);

	if (action === "Approve") {
		await store.approve(plan.id);
		ctx.ui.notify(`Plan ${plan.id} approved.`, "info");
	} else if (action === "Approve & Execute") {
		await store.approve(plan.id);
		ctx.ui.notify(`Plan ${plan.id} approved. Starting execution...`, "info");
		await executeFromCommand(plan.id, ctx, pi, startExecution);
	} else if (action === "Execute") {
		ctx.ui.notify(`Starting execution of ${plan.id}...`, "info");
		await executeFromCommand(plan.id, ctx, pi, startExecution);
	} else if (action === "Reject") {
		const feedback = await ctx.ui.editor("Rejection feedback:", "");
		const reason = feedback?.trim() || "Rejected via /plans command";
		await store.reject(plan.id, reason);
		ctx.ui.notify(`Plan ${plan.id} rejected.`, "info");
	} else if (action === "Cancel") {
		const confirmed = await ctx.ui.confirm("Cancel plan?", `Cancel ${plan.id}: ${plan.title}`);
		if (confirmed) {
			await store.cancel(plan.id);
			ctx.ui.notify(`Plan ${plan.id} cancelled.`, "info");
		}
	} else if (action === "Retry") {
		// Reset to approved and re-execute
		await store.update(plan.id, (p) => {
			p.status = "approved";
			p.result_summary = undefined;
			p.execution_started_at = undefined;
			p.execution_ended_at = undefined;
			p.execution_session = undefined;
			p.scripts = undefined;
		});
		ctx.ui.notify(`Plan ${plan.id} reset to approved. Starting execution...`, "info");
		await executeFromCommand(plan.id, ctx, pi, startExecution);
	} else if (action === "Clone") {
		// Create a new plan with the same content
		const cloned = await store.create({
			title: plan.title,
			steps: plan.steps,
			context: plan.context,
			tools_required: plan.tools_required,
			planner_model: plan.planner_model,
			executor_model: plan.executor_model,
		});
		ctx.ui.notify(`Cloned as ${cloned.id} (proposed). Original: ${plan.id}`, "info");
	} else if (action === "Mark as Completed") {
		const summary = await ctx.ui.editor("Completion summary:", "Manually completed via /plans");
		await store.markCompleted(plan.id, summary?.trim() || "Manually completed");
		ctx.ui.notify(`Plan ${plan.id} marked as completed.`, "info");
	} else if (action === "Mark as Failed") {
		const reason = plan.status === "stalled"
			? "Marked as failed after stalling"
			: await ctx.ui.editor("Failure reason:", "Manually marked as failed") ?? "Manually marked as failed";
		await store.markFailed(plan.id, reason.trim());
		ctx.ui.notify(`Plan ${plan.id} marked as failed.`, "info");
	} else if (action === "Delete") {
		const confirmed = await ctx.ui.confirm("Delete plan?", `Permanently delete ${plan.id}: ${plan.title}`);
		if (confirmed) {
			await store.delete(plan.id);
			ctx.ui.notify(`Plan ${plan.id} deleted.`, "info");
		}
	}
}

async function reviewPlan(
	plan: Plan,
	store: PlanStore,
	ctx: ExtensionContext,
	startExecution: ExecutionStarter,
	pi: ExtensionAPI,
): Promise<void> {
	const detail = formatPlanDetail(plan);
	const action = await ctx.ui.select(detail, ["Approve", "Approve & Execute", "Reject", "Cancel"]);

	if (action === "Approve") {
		await store.approve(plan.id);
		ctx.ui.notify(`Plan ${plan.id} approved.`, "info");
	} else if (action === "Approve & Execute") {
		await store.approve(plan.id);
		ctx.ui.notify(`Plan ${plan.id} approved. Starting execution...`, "info");
		await executeFromCommand(plan.id, ctx, pi, startExecution);
	} else if (action === "Reject") {
		const feedback = await ctx.ui.editor("Rejection feedback:", "");
		const reason = feedback?.trim() || "Rejected via /plan command";
		await store.reject(plan.id, reason);
		ctx.ui.notify(`Plan ${plan.id} rejected.`, "info");
	}
}

function formatPlanDetail(plan: Plan): string {
	const lines: string[] = [
		plan.title,
		"",
		`Status: ${plan.status}  |  Version: ${plan.version}  |  Tools: ${plan.tools_required.join(", ")}`,
		"",
		"Steps:",
	];

	for (let i = 0; i < plan.steps.length; i++) {
		const s = plan.steps[i];
		const target = s.target ? ` → ${s.target}` : "";
		const scriptStatus = plan.scripts?.[i]?.status;
		const statusMark = scriptStatus === "success" ? " ✓" : scriptStatus === "failed" ? " ✗" : "";
		lines.push(`  ${i + 1}. ${s.description} (${s.tool}: ${s.operation}${target})${statusMark}`);
	}

	if (plan.context) {
		lines.push("", "Context:", `  ${plan.context.slice(0, 200)}${plan.context.length > 200 ? "..." : ""}`);
	}

	if (plan.result_summary) {
		lines.push("", `Result: ${plan.result_summary}`);
	}

	return lines.join("\n");
}
