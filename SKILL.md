---
name: pi-planner
description: >-
  Plan mode and plan proposal tools for consequential external actions.
  Use when: planning Odoo writes, email sends, calendar changes, deployments,
  cross-system workflows, or any irreversible operation that needs user approval.
  Triggers: plan mode, plan_propose, plan_approve, consequential action, external action,
  deploy plan, send plan, plan skill safety, safety registry.
---

# Plan Mode

You have `plan_mode` and `plan_propose` tools for planning consequential actions.

## Plan Mode — When to Enter and Exit

**Call `plan_mode(enable: true)` when:**
- The user says "let's plan", "prepare", "think through", or similar planning language
- You're about to research/gather context for external actions (Odoo writes, emails, deploys)
- The conversation shifts from implementation to planning consequential actions

**Call `plan_mode(enable: false)` when:**
- Planning is done (plan proposed, approved, or rejected) and you're resuming normal work
- The user asks you to do something that needs full tool access (edit, write, build, test)
- The user says "exit plan mode", "stop planning", or similar

**In plan mode** your tools are restricted to read-only: `read`, safe `bash` commands, and `plan_*` tools. File edits, writes, and destructive commands are blocked. This prevents accidental side effects while you research and plan.

## When to Use plan_propose

Use `plan_propose` ONLY for consequential external actions:
- Writing to external systems (Odoo, email send, calendar, databases)
- Actions on behalf of other users
- Irreversible operations (deploy, send, delete)
- Multi-step workflows across systems

Do NOT plan for normal development work:
- File edits, code changes, refactoring
- Git operations (commit, push, branch)
- Build, test, lint commands
- Reading from any system
- Creating drafts or TODOs

## Workflow

1. Enter plan mode: `plan_mode(enable: true)`
2. Gather context (read records, emails, data — all read-only tools work)
3. Propose: `plan_propose(title, steps, context)`
4. Wait for human approval (user uses `/plan` or `/plans` in TUI, or `plan_approve` tool)
5. Exit plan mode: `plan_mode(enable: false)`

## Skill Safety Registry

When you read a skill that classifies operations with safety levels (READ, WRITE, DESTRUCTIVE, etc.), **call `plan_skill_safety`** to register those classifications. This enables intelligent plan mode filtering — READ operations (search, list, get) will be allowed in plan mode instead of blocked.

Extract command patterns from the skill docs and map them to READ or WRITE:
- **READ**: pure queries with no side effects (search, list, get, describe, show)
- **WRITE**: everything else — collapse DESTRUCTIVE/EXPENSIVE/SECURITY/FORBIDDEN to WRITE

Use glob patterns with `*` as wildcard. Patterns must start with the tool/CLI name.

```
plan_skill_safety({
  tool: "go-gmail",
  commands: {
    "npx go-gmail * search *": "READ",
    "npx go-gmail * get *": "READ",
    "npx go-gmail * thread *": "READ",
    "npx go-gmail * send *": "WRITE",
    "npx go-gmail * draft *": "WRITE"
  },
  default: "WRITE"
})
```

Call once per tool/CLI after reading its skill documentation. If in doubt, classify as WRITE.

## Available Executor Tools

Check your context for the current tool inventory. Common tools:
- `odoo-toolbox`: read, write, create, delete, search
- `go-easy`: gmail (search, draft, send), calendar (list, create, delete)
