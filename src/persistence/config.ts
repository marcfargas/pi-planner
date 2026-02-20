/**
 * Load planner config from .pi/plans.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type PlannerConfig, DEFAULT_CONFIG } from "./types.js";

const CONFIG_FILE = ".pi/plans.json";

export function loadConfig(projectRoot: string): PlannerConfig {
	const configPath = path.join(projectRoot, CONFIG_FILE);
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			guardedTools: Array.isArray(parsed.guardedTools) ? parsed.guardedTools : DEFAULT_CONFIG.guardedTools,
			stale_after_days: typeof parsed.stale_after_days === "number" ? parsed.stale_after_days : DEFAULT_CONFIG.stale_after_days,
			executor_timeout_minutes: typeof parsed.executor_timeout_minutes === "number" ? parsed.executor_timeout_minutes : DEFAULT_CONFIG.executor_timeout_minutes,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
