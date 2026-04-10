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

const DEFAULT_MAX_CALLS = 5;
const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdvisorConfig {
  const rawMax = env.ADVISOR_MAX_CALLS?.trim();
  const parsedMax = rawMax ? Number(rawMax) : DEFAULT_MAX_CALLS;
  const maxCalls =
    Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_MAX_CALLS;

  const rawEnabled = env.ADVISOR_ENABLED?.trim().toLowerCase() ?? "";

  return {
    model: env.ADVISOR_MODEL?.trim() || "opus",
    maxCalls,
    enabled: !DISABLED_VALUES.has(rawEnabled),
  };
}
