/**
 * Plan file CRUD with atomic writes and optimistic locking.
 *
 * Plans are stored as markdown files with YAML frontmatter in {project}/.pi/plans/.
 * In-memory cache with write-through to disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { type Plan, type PlanListOptions, type PlanStep, type PlanStatus } from "./types.js";

const PLANS_DIR = ".pi/plans";
const _SESSIONS_DIR = ".pi/plans/sessions";
const _ARTIFACTS_DIR = ".pi/plans/artifacts";
const _ARCHIVE_DIR = ".pi/plans/archive";

export class PlanStore {
	private readonly plansDir: string;
	private cache: Map<string, Plan> = new Map();
	private cacheLoaded = false;

	constructor(private readonly projectRoot: string) {
		this.plansDir = path.join(projectRoot, PLANS_DIR);
	}

	// ── Create ──────────────────────────────────────────────

	async create(input: {
		title: string;
		steps: PlanStep[];
		context?: string;
		planner_model?: string;
		tools_required: string[];
		executor_model?: string;
	}): Promise<Plan> {
		const id = `PLAN-${crypto.randomBytes(4).toString("hex")}`;
		const now = new Date().toISOString();

		const plan: Plan = {
			id,
			title: input.title,
			status: "proposed",
			version: 1,
			created_at: now,
			updated_at: now,
			planner_model: input.planner_model,
			tools_required: input.tools_required,
			executor_model: input.executor_model,
			steps: input.steps,
			context: input.context,
		};

		await this.ensureDir();
		const filePath = this.planPath(id);
		await fs.promises.writeFile(filePath, serializePlan(plan), "utf-8");
		this.cache.set(id, plan);

		return plan;
	}

	// ── Read ────────────────────────────────────────────────

	async get(id: string): Promise<Plan | null> {
		if (this.cache.has(id)) return this.cache.get(id)!;
		await this.loadCache();
		return this.cache.get(id) ?? null;
	}

	async list(options?: PlanListOptions): Promise<Plan[]> {
		await this.loadCache();
		let plans = Array.from(this.cache.values());

		if (options?.status) {
			const statuses = Array.isArray(options.status) ? options.status : [options.status];
			plans = plans.filter((p) => statuses.includes(p.status));
		}

		return plans.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	// ── Update ──────────────────────────────────────────────

	async update(id: string, updater: (plan: Plan) => void): Promise<Plan> {
		const filePath = this.planPath(id);

		// Read current state from disk (not cache — for optimistic lock)
		const content = await fs.promises.readFile(filePath, "utf-8");
		const plan = parsePlan(content);
		const expectedVersion = plan.version;

		// Apply update
		updater(plan);
		plan.version++;
		plan.updated_at = new Date().toISOString();

		// Write to temp file
		const tmpPath = `${filePath}.tmp-${Date.now()}`;
		await fs.promises.writeFile(tmpPath, serializePlan(plan), "utf-8");

		// Optimistic lock: verify version hasn't changed
		const current = parsePlan(await fs.promises.readFile(filePath, "utf-8"));
		if (current.version !== expectedVersion) {
			await fs.promises.unlink(tmpPath).catch(() => {});
			throw new Error(
				`Plan ${id} was modified concurrently (expected v${expectedVersion}, found v${current.version})`,
			);
		}

		// Atomic rename
		await fs.promises.rename(tmpPath, filePath);
		this.cache.set(id, plan);

		return plan;
	}

	// ── Status transitions ──────────────────────────────────

	async approve(id: string): Promise<Plan> {
		return this.update(id, (p) => {
			if (p.status !== "proposed") throw new Error(`Cannot approve plan in status: ${p.status}`);
			p.status = "approved";
		});
	}

	async reject(id: string, feedback?: string): Promise<Plan> {
		return this.update(id, (p) => {
			if (p.status !== "proposed") throw new Error(`Cannot reject plan in status: ${p.status}`);
			p.status = "rejected";
			if (feedback) {
				p.body = (p.body ?? "") + `\n\n## Rejection (v${p.version})\n${feedback}`;
			}
		});
	}

	async cancel(id: string): Promise<Plan> {
		return this.update(id, (p) => {
			p.status = "cancelled";
		});
	}

	async markExecuting(id: string): Promise<Plan> {
		return this.update(id, (p) => {
			if (p.status !== "approved") throw new Error(`Cannot execute plan in status: ${p.status}`);
			p.status = "executing";
			p.execution_started_at = new Date().toISOString();
		});
	}

	async markCompleted(id: string, summary: string): Promise<Plan> {
		return this.update(id, (p) => {
			p.status = "completed";
			p.execution_ended_at = new Date().toISOString();
			p.result_summary = summary;
		});
	}

	async markFailed(id: string, error: string): Promise<Plan> {
		return this.update(id, (p) => {
			p.status = "failed";
			p.execution_ended_at = new Date().toISOString();
			p.result_summary = error;
		});
	}

	async delete(id: string): Promise<void> {
		await this.loadCache();
		const plan = this.cache.get(id);
		if (!plan) throw new Error(`Plan ${id} not found`);
		if (plan.status === "executing") {
			throw new Error(`Cannot delete plan ${id} while executing`);
		}
		const filePath = this.planPath(id);
		await fs.promises.unlink(filePath);
		this.cache.delete(id);
	}

	// ── Internals ───────────────────────────────────────────

	private planPath(id: string): string {
		return path.join(this.plansDir, `${id}.md`);
	}

	private async ensureDir(): Promise<void> {
		await fs.promises.mkdir(this.plansDir, { recursive: true });
	}

	private async loadCache(): Promise<void> {
		if (this.cacheLoaded) return;
		try {
			await this.ensureDir();
			const files = await fs.promises.readdir(this.plansDir);
			for (const file of files) {
				if (!file.startsWith("PLAN-") || !file.endsWith(".md")) continue;
				try {
					const content = await fs.promises.readFile(path.join(this.plansDir, file), "utf-8");
					const plan = parsePlan(content);
					this.cache.set(plan.id, plan);
				} catch {
					// Skip unparseable files
				}
			}
		} catch {
			// Dir doesn't exist yet — empty cache is fine
		}
		this.cacheLoaded = true;
	}

	/** Force cache reload (for testing or after external changes) */
	invalidateCache(): void {
		this.cache.clear();
		this.cacheLoaded = false;
	}
}

// ── Serialization ─────────────────────────────────────────

export function serializePlan(plan: Plan): string {
	const lines: string[] = ["---"];

	lines.push(`id: ${plan.id}`);
	lines.push(`title: "${plan.title.replace(/"/g, '\\"')}"`);
	lines.push(`status: ${plan.status}`);
	lines.push(`version: ${plan.version}`);
	lines.push(`created_at: ${plan.created_at}`);
	lines.push(`updated_at: ${plan.updated_at}`);

	if (plan.planner_model) lines.push(`planner_model: ${plan.planner_model}`);
	if (plan.tools_required.length > 0) {
		lines.push(`tools_required:`);
		for (const t of plan.tools_required) lines.push(`  - ${t}`);
	}
	if (plan.executor_model) lines.push(`executor_model: ${plan.executor_model}`);
	if (plan.execution_session) lines.push(`execution_session: ${plan.execution_session}`);
	if (plan.execution_started_at) lines.push(`execution_started_at: ${plan.execution_started_at}`);
	if (plan.execution_ended_at) lines.push(`execution_ended_at: ${plan.execution_ended_at}`);
	if (plan.result_summary) lines.push(`result_summary: "${plan.result_summary.replace(/"/g, '\\"')}"`);

	lines.push("---");
	lines.push("");

	// Body: steps
	if (plan.steps.length > 0) {
		lines.push("## Steps");
		for (let i = 0; i < plan.steps.length; i++) {
			const s = plan.steps[i];
			const target = s.target ? ` → ${s.target}` : "";
			lines.push(`${i + 1}. ${s.description} (${s.tool}: ${s.operation}${target})`);
		}
		lines.push("");
	}

	// Body: context
	if (plan.context) {
		lines.push("## Context");
		lines.push(plan.context);
		lines.push("");
	}

	// Body: extra content
	if (plan.body) {
		lines.push(plan.body);
	}

	return lines.join("\n") + "\n";
}

export function parsePlan(content: string): Plan {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) throw new Error("Invalid plan file: no frontmatter");

	const frontmatter = fmMatch[1];
	const body = fmMatch[2].trim();

	const fm = parseFrontmatter(frontmatter);

	// Parse steps from body
	const steps: PlanStep[] = [];
	const stepsMatch = body.match(/## Steps\n([\s\S]*?)(?=\n## |$)/);
	if (stepsMatch) {
		const stepLines = stepsMatch[1].trim().split("\n");
		for (const line of stepLines) {
			const m = line.match(/^\d+\.\s+(.+?)\s+\((\S+?):\s+(\S+?)(?:\s+→\s+(.+?))?\)$/);
			if (m) {
				steps.push({
					description: m[1],
					tool: m[2],
					operation: m[3],
					target: m[4],
				});
			}
		}
	}

	// Parse context from body
	const ctxMatch = body.match(/## Context\n([\s\S]*?)(?=\n## |$)/);
	const context = ctxMatch ? ctxMatch[1].trim() : undefined;

	// Remaining body (after steps and context sections)
	let remaining = body;
	if (stepsMatch) remaining = remaining.replace(/## Steps\n[\s\S]*?(?=\n## |$)/, "");
	if (ctxMatch) remaining = remaining.replace(/## Context\n[\s\S]*?(?=\n## |$)/, "");
	remaining = remaining.trim();

	return {
		id: fm.id ?? "",
		title: fm.title ?? "",
		status: (fm.status as PlanStatus) ?? "proposed",
		version: parseInt(fm.version ?? "1", 10),
		created_at: fm.created_at ?? "",
		updated_at: fm.updated_at ?? "",
		planner_model: fm.planner_model,
		tools_required: fm.tools_required ?? [],
		executor_model: fm.executor_model,
		execution_session: fm.execution_session,
		execution_started_at: fm.execution_started_at,
		execution_ended_at: fm.execution_ended_at,
		result_summary: fm.result_summary,
		steps,
		context,
		body: remaining || undefined,
	};
}

function parseFrontmatter(raw: string): Record<string, any> {
	const result: Record<string, any> = {};
	let currentList: string[] | null = null;
	let currentKey: string | null = null;

	for (const line of raw.split("\n")) {
		const listItem = line.match(/^\s+-\s+(.+)$/);
		if (listItem && currentKey) {
			if (!currentList) currentList = [];
			currentList.push(listItem[1].trim());
			result[currentKey] = currentList;
			continue;
		}

		// Flush any pending list
		currentList = null;
		currentKey = null;

		const kv = line.match(/^(\S+?):\s*(.*)$/);
		if (kv) {
			const key = kv[1];
			let value = kv[2].trim();
			// Strip quotes
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1).replace(/\\"/g, '"');
			}
			if (value === "") {
				// Could be start of a list
				currentKey = key;
			} else {
				result[key] = value;
			}
		}
	}

	return result;
}
