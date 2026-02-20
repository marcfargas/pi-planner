# @marcfargas/pi-planner

## 0.3.0

### Minor Changes

- ### executor_model support

  Plans can now specify `executor_model` (provider/model-id) via `plan_propose`. The planner switches to the requested model before execution and restores the original model on completion. Graceful fallback when model is unavailable.

  ### Fix: plan_run_script not found during execution

  Root cause: pi's agent loop captures a tool snapshot at loop start. Follow-up messages (used to deliver the executor prompt) reuse the old snapshot, which didn't include `plan_run_script`.

  Fix: executor prompt is now returned inline in `plan_approve`'s tool result, so the agent processes it in the same turn where all tools are already available.

  ### Manual plan completion

  `/plans` now offers "Mark as Completed" and "Mark as Failed" for executing plans, providing a workaround for stuck executions.

## 0.2.1

### Patch Changes

- Add comprehensive harness tests and fix SKILL SAFETY instruction.

  - 26 harness tests covering plan mode tool blocking, plan lifecycle (propose/approve/reject/list/get),
    plan_run_script error handling, safety registry integration, and tool sequence verification
  - Fix SKILL SAFETY instruction text to clarify runner prefix support ("npx go-gmail" patterns)
  - Fix safety-hooks unit test to use correct tool name format (`"go-gmail"` not `"npx go-gmail"`)

- Updated dependencies []:
  - @marcfargas/pi-safety@0.1.1

## 0.2.0

### Minor Changes

- [`bba7d20`](https://github.com/marcfargas/pi-mf-extensions/commit/bba7d20b189ee8be4eecd96606a0ee17262d76c2) Thanks [@marcfargas](https://github.com/marcfargas)! - Initial release.

  - Plan-then-execute workflow: agent proposes → human reviews → approves → executor runs
  - 7 agent tools: `plan_mode`, `plan_propose`, `plan_list`, `plan_get`, `plan_approve`, `plan_reject`, `plan_skill_safety`
  - **Skill safety registry (LLM-as-parser)**: agent reads skill docs, extracts safety annotations, reports command patterns via `plan_skill_safety`. READ operations allowed in plan mode, WRITE operations blocked. Zero skill author burden, zero hardcoded tool knowledge.
  - Plan mode with graduated bash filtering: safe commands allowlisted, skill operations classified by registry, everything else blocked
  - Plans stored as markdown files with YAML frontmatter — auditable, diffable, crash-safe
  - Optimistic locking, atomic writes, stalled plan detection
  - TUI commands: `/plan`, `/plans`, `/safety`
  - Session state persistence across restarts
  - 240 tests, TypeScript strict mode
