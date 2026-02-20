/**
 * Stalled plan detection and crash recovery.
 *
 * On session_start, check for plans stuck in "executing" status
 * that have exceeded the timeout. Mark them as stalled.
 */

import type { Plan } from "../persistence/types.js";

/**
 * Find plans that are stuck in "executing" status past the timeout.
 */
export function findStalledPlans(executingPlans: Plan[], timeoutMinutes: number): Plan[] {
	const now = Date.now();
	const timeoutMs = timeoutMinutes * 60 * 1000;

	return executingPlans.filter((p) => {
		if (!p.execution_started_at) return false;
		const startedAt = new Date(p.execution_started_at).getTime();
		return now - startedAt > timeoutMs;
	});
}

/**
 * Format stalled plan info for user notification.
 */
export function formatStalledPlanMessage(plan: Plan): string {
	const started = plan.execution_started_at ?? "unknown";
	const elapsed = plan.execution_started_at
		? Math.round((Date.now() - new Date(plan.execution_started_at).getTime()) / 60000)
		: 0;

	return `Plan ${plan.id} "${plan.title}" has been executing for ${elapsed}m (started: ${started}). Steps: ${plan.steps.length}`;
}
