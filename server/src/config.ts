/**
 * Reads plugin configuration from environment variables. Engineers configure
 * nothing — org-wide defaults can be pushed via managed settings' top-level
 * `env` block, which Claude Code exposes to child processes.
 */
export interface AdvisorConfig {
  /** Model alias or full ID passed to `claude -p --model`. */
  model: string;
  /** Max advisor calls per server lifetime. */
  maxCalls: number;
  /** Kill switch — false disables the tool without uninstalling. */
  enabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdvisorConfig {
  const rawMax = env.ADVISOR_MAX_CALLS;
  const parsedMax = rawMax === undefined ? 5 : Number(rawMax);
  const maxCalls = Number.isFinite(parsedMax) && parsedMax >= 0 ? parsedMax : 5;

  return {
    model: env.ADVISOR_MODEL?.trim() || "opus",
    maxCalls,
    enabled: env.ADVISOR_ENABLED !== "false",
  };
}
