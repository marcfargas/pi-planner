# pi-planner — Motivation

## Why Plan Mode?

AI agents that interact with external systems (ERP, email, calendars, databases) need a way to propose actions before executing them. Without this:

1. **No audit trail** — who approved sending that email?
2. **No undo** — the invoice was already created when the user noticed the error
3. **No visibility** — the agent just "did things" in the background
4. **No safety** — a hallucinated tool call can modify production data

Plan mode introduces a **propose → review → approve → execute** workflow that makes agent actions visible, auditable, and reversible (before execution).

## Why Not Just Use Confirmation Dialogs?

Confirmation per tool call (e.g., "Allow this Odoo write?") fails because:

- **No overview** — user sees one action at a time, can't assess the full sequence
- **Decision fatigue** — 10 confirmations for a 10-step workflow trains users to click "yes"
- **No cross-step review** — step 5 might be wrong given what step 3 did, but you approved step 3 already
- **No persistence** — if the session crashes, there's no record of what was planned

Plans solve all four: the user reviews the full sequence as a unit, approves once, and the plan persists on disk.

## Why Not Chain-of-Thought or Reasoning?

CoT/reasoning happens inside the model — it's internal deliberation about *how* to do something. Plans are about *what* to do — specifically, what external side effects the agent will produce.

They're complementary: the agent uses reasoning to figure out the right plan, then proposes it for human review.

## Why Not Just SKILL.md Guidance?

SKILL.md tells the agent when to plan. But it's a prompt — the agent might ignore it. pi-planner adds:

- **Tools** — `plan_propose` gives the agent a structured way to propose
- **Persistence** — plans are files on disk, not ephemeral conversation
- **Guard rails** — `tool_call` hook logs (Phase A) or blocks (Phase C) unplanned writes
- **UI integration** — `/plan`, `/plans` commands for human review

SKILL.md is the first line of defense. The extension is the second.

## Comparison with Alternatives

| Approach | Audit | Multi-step review | Persistence | Enforcement |
|----------|-------|-------------------|-------------|-------------|
| Confirmation dialogs | ❌ | ❌ | ❌ | ✅ |
| SKILL.md "plan before acting" | ❌ | ✅ (in conversation) | ❌ | ❌ |
| **pi-planner** | ✅ | ✅ | ✅ | ✅ (Phase C) |
| External orchestrators (Temporal, etc.) | ✅ | Varies | ✅ | ✅ |

External orchestrators are overkill for an AI coding agent. pi-planner is lightweight (files on disk, no server) and composable (works in TUI, chat gateway, dashboard).

## Failure Modes

### Over-planning (most likely)

Agent proposes plans for trivial actions. User gets annoyed, disables the feature.

**Mitigations:**
- SKILL.md clearly defines what needs a plan vs. "just do it"
- TUI defaults: `guardedTools: []` — no enforcement, purely opt-in
- Phase A logging generates data to tune the boundary

### Under-planning (most dangerous)

Agent sends an email or writes to Odoo without proposing a plan.

**Mitigations:**
- `guardedTools` in chat-agents blocks the action at `tool_call` level
- Phase A logs violations for review
- Phase C enforces: blocked with "this tool requires a plan"

### Executor crash mid-plan

Steps 1-2 completed, step 3 crashes. Orphaned state (invoice created but email not sent).

**Mitigations:**
- Step checkpointing in `.pi/plans/sessions/PLAN-{id}.jsonl`
- Stalled detection (executing > timeout → `stalled` status)
- Explicit policy: "fail and report, don't auto-rollback"
- Limitation: no automatic rollback in v1. Document what state was left behind.

### Stale plan accumulation

Plans pile up in `proposed` status, never approved.

**Mitigations:**
- Configurable `stale_after_days` (default: 30 TUI, 7 chat-agents)
- `/plans` command surfaces pending count
- Future: auto-cancel with notification

### Planner hallucination

Plan references tools that don't exist or steps that are impossible.

**Mitigations:**
- Pre-flight validation at approval time: all `tools_required` must exist
- Tool inventory injected via `before_agent_start` so planner knows what's available
- Executor refuses to start if tools are missing

## Design Principles

1. **File on disk is source of truth** — events are optimizations, not guarantees
2. **Lean frontmatter** — only fields with consumers; add more when needed
3. **Prompt guidance first, enforcement second** — SKILL.md guides; `tool_call` hook enforces
4. **Composable** — same package works in TUI, chat gateway, dashboard
5. **Fail safe** — crash → report, not crash → auto-rollback
