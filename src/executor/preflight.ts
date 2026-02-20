/**
 * Pre-flight validation before executor spawning.
 *
 * Validates:
 * 1. Plan is in approved status
 * 2. Plan version matches (no concurrent modification)
 * 3. All tools_required exist in the current environment
 */

export interface PreflightResult {
	ok: boolean;
	error?: string;
}

export function validatePreflight(
	plan: { status: string; version: number; tools_required: string[] },
	expectedVersion: number,
	availableTools: string[],
): PreflightResult {
	// Status check
	if (plan.status !== "approved") {
		return {
			ok: false,
			error: `Plan is in "${plan.status}" status, expected "approved"`,
		};
	}

	// Version check (optimistic locking)
	if (plan.version !== expectedVersion) {
		return {
			ok: false,
			error: `Plan version mismatch: expected v${expectedVersion}, found v${plan.version}`,
		};
	}

	// Tool availability check
	const availableSet = new Set(availableTools);
	const missing = plan.tools_required.filter((t) => !availableSet.has(t));
	if (missing.length > 0) {
		return {
			ok: false,
			error: `Required tools not available: ${missing.join(", ")}`,
		};
	}

	return { ok: true };
}
