/**
 * Plan tools: plan_propose, plan_list, plan_get, plan_approve, plan_reject.
 * (plan_mode is registered in index.ts where mode state lives.)
 *
 * Registered via pi.registerTool() with TypeBox schemas.
 */

import type { ExtensionAPI, ExtensionContext, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { PlanStore } from "../persistence/plan-store.js";
import type { PlanStatus } from "../persistence/types.js";

type ExecutionStarter = (planId: string, ctx: ExtensionContext) => Promise<string | undefined>;

// ── Schemas ─────────────────────────────────────────────────

const StepSchema = Type.Object({
	description: Type.String({ description: "What this step does" }),
	tool: Type.String({ description: "Tool needed (e.g., odoo-toolbox, go-easy)" }),
	operation: Type.String({ description: "Specific operation (e.g., write, draft, send)" }),
	target: Type.Optional(Type.String({ description: "Target entity/record if known" })),
});

const ProposeParams = Type.Object({
	title: Type.String({ description: "Short description of what this plan does" }),
	steps: Type.Array(StepSchema, { description: "Ordered list of actions to execute" }),
	context: Type.Optional(Type.String({ description: "Structured context gathered during planning (tool outputs, notes)" })),
	executor_model: Type.Optional(Type.String({ description: "Model to use for plan execution (provider/model-id, e.g. 'anthropic/claude-sonnet-4'). Defaults to current model." })),
});

const ListParams = Type.Object({
	status: Type.Optional(Type.String({ description: "Filter by status (proposed, approved, executing, completed, failed, rejected, cancelled)" })),
});

const IdParams = Type.Object({
	id: Type.String({ description: "Plan ID (e.g., PLAN-a1b2c3d4)" }),
});

const RejectParams = Type.Object({
	id: Type.String({ description: "Plan ID to reject" }),
	feedback: Type.Optional(Type.String({ description: "Rejection reason or feedback for re-planning" })),
});

// ── Helpers ─────────────────────────────────────────────────

function textResult<T = unknown>(text: string, isError = false): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		details: {} as T,
		...(isError ? { isError: true } : {}),
	} as AgentToolResult<T>;
}

// ── Registration ────────────────────────────────────────────

export function registerPlanTools(
	pi: ExtensionAPI,
	getStore: (cwd: string) => PlanStore,
	onApprove?: ExecutionStarter,
): void {
	// plan_propose
	pi.registerTool({
		name: "plan_propose",
		label: "Plan Propose",
		description: `Propose a plan for consequential external actions that need user approval.
Use for: Odoo writes, email sends, calendar changes, deployments, cross-system workflows.
Do NOT use for: file edits, git ops, build/test commands, reading from systems.
The plan will be presented to the user for approval before execution.`,
		parameters: ProposeParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof ProposeParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const store = getStore(ctx.cwd);
			const toolsRequired = [...new Set(params.steps.map((s) => s.tool))];
			const plan = await store.create({
				title: params.title,
				steps: params.steps,
				context: params.context,
				tools_required: toolsRequired,
				executor_model: params.executor_model,
			});

			const modelLine = plan.executor_model ? `\nExecutor model: ${plan.executor_model}` : "";
			return textResult(
				`Plan created: ${plan.id}\nTitle: ${plan.title}\nStatus: proposed\nSteps: ${plan.steps.length}\nTools: ${toolsRequired.join(", ")}${modelLine}\n\nAwaiting approval. User can approve via /plan or /plans command.`,
			);
		},
	});

	// plan_list
	pi.registerTool({
		name: "plan_list",
		label: "Plan List",
		description: "List plans in the current project. Optionally filter by status.",
		parameters: ListParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof ListParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const store = getStore(ctx.cwd);
			const plans = await store.list(params.status ? { status: params.status as PlanStatus } : undefined);
			if (plans.length === 0) {
				return textResult("No plans found.");
			}
			const text = plans
				.map((p) => `${p.id} [${p.status}] ${p.title} (${p.steps.length} steps, v${p.version})`)
				.join("\n");
			return textResult(text);
		},
	});

	// plan_get
	pi.registerTool({
		name: "plan_get",
		label: "Plan Get",
		description: "Get full details of a plan by ID.",
		parameters: IdParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof IdParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const store = getStore(ctx.cwd);
			const plan = await store.get(params.id);
			if (!plan) {
				return textResult(`Plan ${params.id} not found.`, true);
			}
			const lines = [
				`# ${plan.title}`,
				"",
				`- **ID**: ${plan.id}`,
				`- **Status**: ${plan.status}`,
				`- **Version**: ${plan.version}`,
				`- **Created**: ${plan.created_at}`,
				`- **Tools**: ${plan.tools_required.join(", ")}`,
				plan.executor_model ? `- **Executor model**: ${plan.executor_model}` : null,
				plan.result_summary ? `- **Result**: ${plan.result_summary}` : null,
				"",
				"## Steps",
				...plan.steps.map(
					(s, i) =>
						`${i + 1}. ${s.description} (${s.tool}: ${s.operation}${s.target ? ` → ${s.target}` : ""})`,
				),
			].filter(Boolean);

			if (plan.context) {
				lines.push("", "## Context", plan.context);
			}

			return textResult(lines.join("\n"));
		},
	});

	// plan_approve
	pi.registerTool({
		name: "plan_approve",
		label: "Plan Approve",
		description: "Approve a proposed plan for execution. Once approved, the plan will be executed automatically.",
		parameters: IdParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof IdParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const store = getStore(ctx.cwd);
			try {
				const plan = await store.approve(params.id);

				// Start execution — returns the executor prompt to include in tool result
				if (onApprove) {
					const executorPrompt = await onApprove(plan.id, ctx);
					if (executorPrompt) {
						return textResult(
							`Plan ${plan.id} approved and execution started.\n\n${executorPrompt}`,
						);
					}
				}

				return textResult(`Plan ${plan.id} approved. Status: ${plan.status}. Awaiting execution.`);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return textResult(`Failed to approve: ${msg}`, true);
			}
		},
	});

	// plan_reject
	pi.registerTool({
		name: "plan_reject",
		label: "Plan Reject",
		description: "Reject a proposed plan with optional feedback.",
		parameters: RejectParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof RejectParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const store = getStore(ctx.cwd);
			try {
				const plan = await store.reject(params.id, params.feedback);
				return textResult(
					`Plan ${plan.id} rejected.${params.feedback ? ` Feedback: ${params.feedback}` : ""}`,
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return textResult(`Failed to reject: ${msg}`, true);
			}
		},
	});
}
