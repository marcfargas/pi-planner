/**
 * Step-level checkpointing for plan execution.
 *
 * Logs each step's start/result to .pi/plans/sessions/PLAN-{id}.jsonl
 * Enables crash recovery: on restart, read checkpoint to determine
 * which steps completed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = ".pi/plans/sessions";

export interface StepCheckpoint {
	step: number;
	tool: string;
	operation: string;
	status: "started" | "success" | "failed";
	result_summary?: string;
	error?: string;
	timestamp: string;
}

export interface ExecutionCheckpoint {
	plan_id: string;
	started_at: string;
	ended_at?: string;
	steps: StepCheckpoint[];
}

export class CheckpointLogger {
	private readonly filePath: string;

	constructor(projectRoot: string, planId: string) {
		const dir = path.join(projectRoot, SESSIONS_DIR);
		fs.mkdirSync(dir, { recursive: true });
		this.filePath = path.join(dir, `${planId}.jsonl`);
	}

	logStep(checkpoint: StepCheckpoint): void {
		const line = JSON.stringify(checkpoint);
		fs.appendFileSync(this.filePath, `${line}\n`);
	}

	logStart(planId: string): void {
		const entry = {
			type: "execution_start",
			plan_id: planId,
			timestamp: new Date().toISOString(),
		};
		fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
	}

	logEnd(planId: string, status: "completed" | "failed", summary: string): void {
		const entry = {
			type: "execution_end",
			plan_id: planId,
			status,
			summary,
			timestamp: new Date().toISOString(),
		};
		fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
	}

	getFilePath(): string {
		return this.filePath;
	}
}

/**
 * Read checkpoint data to determine execution state.
 * Returns step checkpoints for recovery.
 */
export function readCheckpoint(projectRoot: string, planId: string): StepCheckpoint[] {
	const filePath = path.join(projectRoot, SESSIONS_DIR, `${planId}.jsonl`);
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const steps: StepCheckpoint[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.step !== undefined) {
					steps.push(entry as StepCheckpoint);
				}
			} catch {
				// Skip malformed lines
			}
		}
		return steps;
	} catch {
		return [];
	}
}

/**
 * Count completed steps from checkpoint data.
 */
export function countCompletedSteps(projectRoot: string, planId: string): number {
	const steps = readCheckpoint(projectRoot, planId);
	return steps.filter((s) => s.status === "success").length;
}
