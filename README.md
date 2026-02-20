# @marcfargas/pi-planner

Persistent, auditable plan-then-execute workflow for [pi](https://github.com/mariozechner/pi-coding-agent) agents.

Agent proposes a plan → human reviews → approves or rejects → executor runs in-session.

## Why

AI agents that write to external systems (ERP, email, calendars) need guardrails. Confirmation per tool call doesn't work — you can't assess a 5-step workflow one click at a time.

pi-planner lets the agent propose the full sequence, the human review it as a unit, and approve once. Plans persist on disk as markdown files — auditable, diffable, survives crashes.

See [MOTIVATION.md](MOTIVATION.md) for the full rationale.

## Install

```bash
npm install @marcfargas/pi-planner
```

Add to your pi config:

```json
{
  "pi": {
    "extensions": ["@marcfargas/pi-planner"]
  }
}
```

### Peer dependencies

- `@mariozechner/pi-coding-agent` >= 0.50.0

### Internal dependencies

- `@marcfargas/pi-safety` — safety classification registry (installed automatically)

## Agent Tools

The extension registers 8 tools:

| Tool | Description |
|------|-------------|
| `plan_mode` | Enter/exit plan mode (read-only + plan tools) |
| `plan_propose` | Propose a plan with title, steps, and context |
| `plan_list` | List plans, optionally filtered by status |
| `plan_get` | Get full details of a plan by ID |
| `plan_approve` | Approve a proposed plan for execution |
| `plan_reject` | Reject a plan with optional feedback |
| `plan_skill_safety` | Register skill safety classifications (called after reading skills) |
| `plan_run_script` | Report step outcomes during plan execution |

### When to plan

Plans are for **consequential external actions** — Odoo writes, email sends, calendar changes, deployments, anything irreversible or on behalf of others.

**Not** for file edits, git, build/test, or reading from systems. Those are normal dev work.

The [SKILL.md](SKILL.md) file guides the agent on when to use plan mode and when to propose.

## TUI Commands

| Command | What it does |
|---------|-------------|
| `/plan` | Toggle plan mode, or review pending plans if any exist |
| `/plans` | Browse all plans — approve, reject, retry, clone, delete, view details |
| `/safety` | Inspect the skill safety registry |

## Plan Mode

When the agent enters plan mode (`plan_mode(enable: true)`):

- **Allowed**: `read`, safe `bash` (ls, cat, grep, git status…), all `plan_*` tools
- **Allowed if registered**: Skill operations classified as READ (search, list, get, describe)
- **Blocked**: `write`, `edit`, destructive bash, skill operations classified as WRITE

This prevents accidental side effects while the agent researches and builds the plan.

## Plan Execution

When a plan is approved and executed:

1. Plan mode auto-exits (full tools needed for execution)
2. Tools are scoped to the plan's requirements + `plan_run_script`
3. The agent receives an executor prompt via `sendUserMessage`
4. The agent follows the steps in order, calling `plan_run_script` after each
5. On completion or failure, tools are restored to the previous state

The executor protocol requires the agent to call `plan_run_script` with:
- `step_complete` / `step_failed` after each step
- `plan_complete` / `plan_failed` when done

## Plan Lifecycle

```
proposed ──┬──► approved ──► executing ──┬──► completed
           │                             ├──► failed ──► retry / clone
           ├──► rejected ──► clone       └──► stalled ──► retry / clone
           └──► cancelled
```

- **Retry**: Reset a failed/stalled plan to approved and re-execute
- **Clone**: Create a new proposed plan from any terminal plan's steps and context
- **Optimistic locking**: version increments on every write — concurrent edits are detected
- **Crash recovery**: plans stuck in `executing` past the timeout are marked `stalled`

## Plan Storage

Plans are markdown files with YAML frontmatter in `.pi/plans/`:

```
{project}/.pi/plans/
├── PLAN-a1b2c3d4.md        # Plan files
├── sessions/                # Executor step logs (JSONL)
│   └── PLAN-a1b2c3d4.jsonl
└── artifacts/               # Large context data
```

Example plan file:

```markdown
---
id: PLAN-a1b2c3d4
title: "Send invoice reminder to Acme Corp"
status: proposed
version: 1
tools_required:
  - odoo-toolbox
  - go-easy
---

## Steps
1. Query overdue invoices for Acme Corp (odoo-toolbox: search → account.move)
2. Send payment reminder email (go-easy: send → billing@acme.com)
3. Log reminder activity on invoice (odoo-toolbox: write → account.move)

## Context
Invoice INV-2024-0847 is 30 days overdue. Amount: €1,500.
```

## Skill Safety Registry

The agent reads skill documentation, extracts safety annotations, and calls `plan_skill_safety` with command-matching glob patterns. pi-planner stores the patterns and uses [`@marcfargas/pi-safety`](../pi-safety/) to match them against bash commands at runtime.

**Before:** Plan mode blocked all bash — agent couldn't search Odoo or check Gmail while researching.

**After:** Agent reads skills, registers safety patterns. READ operations (search, list, get) pass through in plan mode. WRITE operations stay blocked.

```
plan_skill_safety({
  tool: "npx go-gmail",
  commands: {
    "npx go-gmail * search *": "READ",
    "npx go-gmail * send *": "WRITE",
  },
  default: "WRITE"
})
```

Use `/safety` to inspect the current registry.

## Configuration

Optional. Create `.pi/plans.json` in your project:

```json
{
  "guardedTools": [],
  "stale_after_days": 30,
  "executor_timeout_minutes": 30
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `guardedTools` | `[]` | Tool names that log a warning when called without an active plan |
| `stale_after_days` | `30` | Days before a proposed plan is considered stale |
| `executor_timeout_minutes` | `30` | Minutes before an executing plan is marked stalled |

## Architecture

```
src/
├── index.ts               Extension entry — mode switching, TUI commands, plan_run_script, lifecycle
├── tools/
│   ├── index.ts           Plan CRUD tools (propose, list, get, approve, reject)
│   └── safety.ts          plan_skill_safety tool
├── mode/
│   └── hooks.ts           Hooks — before_agent_start, tool_call blocking, safety filtering
├── executor/
│   ├── runner.ts          In-session execution via sendUserMessage + setActiveTools
│   ├── checkpoint.ts      Step-level checkpointing (JSONL)
│   ├── preflight.ts       Pre-flight validation (tools exist, plan is approved)
│   └── stalled.ts         Stalled plan detection and timeout
└── persistence/
    ├── plan-store.ts      CRUD, atomic writes, optimistic locking, cache
    ├── types.ts           Plan, PlanStep, PlanScript, PlanStatus, PlannerConfig
    └── config.ts          Reads .pi/plans.json
```

Safety classification types and registry live in [`@marcfargas/pi-safety`](../pi-safety/).

### Extension hooks

| Hook | What it does |
|------|-------------|
| `before_agent_start` | Injects plan-mode context + skill safety extraction instruction |
| `tool_call` | Safety registry resolution → allowlist → block. Logs guarded tools |
| `agent_end` | Cleans up execution state, updates widgets |
| `session_start` | Restores plan mode, detects stalled plans from previous session |
| `context` | Filters stale plan-mode messages when not in plan mode |

## License

MIT
