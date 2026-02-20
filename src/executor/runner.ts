/**
 * Executor runner — orchestrates plan execution in-session.
 *
 * The executor works by returning instructions from plan_approve's tool result,
 * so the agent sees the executor prompt and starts executing in the same turn.
 * The plan_run_script tool is always registered, so it's available for reporting.
 *
 * Flow:
 * 1. Pre-flight validation
 * 2. Mark plan as executing, initialize scripts
 * 3. Return executor prompt (agent acts on it in current turn)
 * 4. Agent executes steps, reports via plan_run_script
 * 5. On completion/failure, restore state (via agent_end hook in index.ts)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanStore } from "../persistence/plan-store.js";
import type { Plan, PlanScript } from "../persistence/types.js";
import { validatePreflight } from "./preflight.js";
import { CheckpointLogger } from "./checkpoint.js";

export interface ExecutionResult {
	ok: boolean;
	error?: string;
	planId: string;
}

/**
 * Mutable state for an active plan execution.
 * Stored in the extension closure (index.ts) — one execution at a time.
 */
export interface ExecutionState {
	planId: string;
	savedTools: string[];
	/** Model that was active before execution (restored on finish). */
	savedModel?: unknown;
	checkpoint: CheckpointLogger;
	store: PlanStore;
	totalSteps: number;
	done: boolean;
	result?: ExecutionResult;
	onStatusUpdate?: () => Promise<void>;
}

/**
 * Build the executor prompt that instructs the agent to follow the plan.
 * Includes plan_run_script reporting protocol.
 */
export function buildExecutorPrompt(plan: Plan): string {
	const toolList = plan.tools_required.join(", ");
	const stepList = plan.steps
		.map((s, i) => `${i + 1}. ${s.description} (${s.tool}: ${s.operation}${s.target ? ` → ${s.target}` : ""})`)
		.join("\n");

	const modelNote = plan.executor_model ? `\n## Executor Model\n${plan.executor_model}\n` : "";

	return `You are now executing an approved plan. Follow the steps exactly.

## Plan: ${plan.title}
## ID: ${plan.id}
${modelNote}
## Available Tools
${toolList}

## Steps
${stepList}

${plan.context ? `## Context\n${plan.context}\n` : ""}
## Execution Protocol
After completing each step, report the outcome using plan_run_script:

1. After each successful step:
   plan_run_script({ action: "step_complete", step: <step_number>, summary: "what was done" })

2. If a step fails:
   plan_run_script({ action: "step_failed", step: <step_number>, summary: "what went wrong" })
   Then immediately:
   plan_run_script({ action: "plan_failed", summary: "Step N failed: reason" })

3. After ALL steps succeed:
   plan_run_script({ action: "plan_complete", summary: "brief summary of all results" })

## Rules
- Follow the plan steps in order
- If a step fails, STOP immediately and report the failure
- Do NOT improvise beyond the plan scope
- Do NOT use bash to work around missing tools
- Report EVERY step outcome via plan_run_script
- Always end with exactly one plan_complete or plan_failed call
- If real-world state doesn't match the plan's assumptions, STOP and report via plan_failed
- If a step references an entity without a unique identifier, STOP and report "ambiguous step"
- Do NOT attempt to undo previous steps unless the plan explicitly includes rollback steps`;
}

/**
 * Render plan as executor task string (used in sendUserMessage).
 */
export function renderPlanForExecutor(plan: Plan): string {
	return `Execute approved plan ${plan.id}: "${plan.title}"

Follow the steps in order. Report each step's outcome via plan_run_script.`;
}

/**
 * Start plan execution in-session.
 *
 * Sets up execution state and returns the executor prompt.
 * The prompt is included in plan_approve's tool result so the agent
 * sees it and starts executing in the same turn — avoiding the tool
 * snapshot issue where follow-up messages can't see newly added tools.
 *
 * Returns either an error or the execution state + prompt text.
 */
export async function executePlan(
	plan: Plan,
	store: PlanStore,
	projectRoot: string,
	availableTools: string[],
	_ctx: ExtensionContext,
	_pi: ExtensionAPI,
	onStatusUpdate?: () => Promise<void>,
): Promise<{ ok: boolean; error?: string; state?: ExecutionState; prompt?: string }> {
	// Pre-flight validation
	const preflight = validatePreflight(plan, plan.version, availableTools);
	if (!preflight.ok) {
		return { ok: false, error: preflight.error };
	}

	// Mark as executing
	try {
		await store.markExecuting(plan.id);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to mark plan as executing: ${msg}` };
	}

	// Initialize step scripts
	const scripts: PlanScript[] = plan.steps.map((_, i) => ({
		stepIndex: i,
		status: "pending" as const,
	}));
	try {
		await store.update(plan.id, (p) => { p.scripts = scripts; });
	} catch {
		// Non-fatal — scripts tracking is nice-to-have
	}

	// Setup checkpoint logger
	const checkpoint = new CheckpointLogger(projectRoot, plan.id);
	checkpoint.logStart(plan.id);

	// Notify widget
	if (onStatusUpdate) await onStatusUpdate();

	// Build executor prompt — returned to caller for inclusion in tool result
	const prompt = buildExecutorPrompt(plan);

	const state: ExecutionState = {
		planId: plan.id,
		savedTools: [], // No tool switching needed — agent uses current tools
		checkpoint,
		store,
		totalSteps: plan.steps.length,
		done: false,
		onStatusUpdate,
	};

	return { ok: true, state, prompt };
}

/**
 * Finish an active execution — restore tools and update plan status.
 * Called from plan_run_script when plan_complete or plan_failed is reported.
 */
export async function finishExecution(
	state: ExecutionState,
	result: ExecutionResult,
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
): Promise<void> {
	state.done = true;
	state.result = result;

	// Restore previous model (if switched for execution)
	if (state.savedModel) {
		try {
			await pi.setModel(state.savedModel as never);
		} catch {
			// Model restore is best-effort
		}
	}

	// Update plan status
	try {
		if (result.ok) {
			state.checkpoint.logEnd(state.planId, "completed", result.error || "Completed successfully");
			await state.store.markCompleted(state.planId, result.error || "Execution completed successfully.");
		} else {
			state.checkpoint.logEnd(state.planId, "failed", result.error || "Failed");
			await state.store.markFailed(state.planId, result.error || "Unknown error");
		}
	} catch {
		// Plan may have been modified concurrently
	}

	if (state.onStatusUpdate) await state.onStatusUpdate();
}
