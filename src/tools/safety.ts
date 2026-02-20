/**
 * plan_skill_safety tool — receives safety classifications from the agent.
 *
 * The agent reads a skill's documentation, extracts safety annotations,
 * and calls this tool with command-matching glob patterns. pi-planner
 * stores them and uses them to allow READ operations in plan mode.
 */

import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { SafetyRegistry } from "@marcfargas/pi-safety";

// ── Schema ──────────────────────────────────────────────────

const SkillSafetyParams = Type.Object({
	tool: Type.String({ description: "Tool or CLI name (e.g., go-gmail, gcloud, az)" }),
	commands: Type.Record(
		Type.String(),
		Type.String(),
		{ description: "Command glob patterns mapped to safety levels. Patterns use * as wildcard. Levels: READ (no side effects) or WRITE (everything else). Example: { \"npx go-gmail * search *\": \"READ\", \"npx go-gmail * send *\": \"WRITE\" }" },
	),
	default: Type.Optional(Type.String({ description: "Default level for operations not matching any pattern (default: WRITE)" })),
});

type SkillSafetyInput = Static<typeof SkillSafetyParams>;

// ── Registration ────────────────────────────────────────────

export function registerSkillSafetyTool(
	pi: ExtensionAPI,
	registry: SafetyRegistry,
): void {
	pi.registerTool({
		name: "plan_skill_safety",
		label: "Skill Safety",
		description: `Register safety classifications extracted from a loaded skill. Called after reading a skill that documents operation safety levels (READ, WRITE, DESTRUCTIVE, etc.).

Extract command patterns from the skill docs and map them to READ or WRITE:
- READ: pure queries with no side effects (search, list, get, describe)
- WRITE: everything else (create, send, delete, deploy — collapse DESTRUCTIVE/EXPENSIVE/SECURITY/FORBIDDEN to WRITE)

Patterns use * as wildcard and must start with the tool/CLI name.
Example: { "npx go-gmail * search *": "READ", "gcloud * list *": "READ", "gcloud * delete *": "WRITE" }`,
		parameters: SkillSafetyParams,
		async execute(
			_toolCallId: string,
			params: SkillSafetyInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const { accepted, rejected } = registry.register(
				params.tool,
				params.commands,
				params.default,
			);

			const lines: string[] = [
				`Registered ${accepted} safety pattern(s) for "${params.tool}".`,
			];

			if (rejected.length > 0) {
				lines.push(`Rejected ${rejected.length} pattern(s):`);
				for (const r of rejected) {
					lines.push(`  - "${r.pattern}": ${r.reason}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {},
			} as AgentToolResult<unknown>;
		},
	});
}
