const DEFAULT_MAX_CALLS = 5;
/**
 * Default transcript budget: ~6k tokens, ~$0.09 extra per Opus call on
 * Bedrock. Deliberately conservative to keep the README's per-call cost
 * bracket honest — see README "Cost model" section.
 */
const DEFAULT_TRANSCRIPT_MAX_CHARS = 24_000;
const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);
function parseBoolean(raw, defaultValue) {
    const normalized = raw?.trim().toLowerCase() ?? "";
    if (normalized === "")
        return defaultValue;
    return !DISABLED_VALUES.has(normalized);
}
function parseNonNegativeInt(raw, defaultValue) {
    const trimmed = raw?.trim();
    if (!trimmed)
        return defaultValue;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}
export function loadConfig(env = process.env) {
    const rawEnabled = env.ADVISOR_ENABLED?.trim().toLowerCase() ?? "";
    // Preserve v0.1 semantics: a blank `ADVISOR_ENABLED` leaves the tool enabled.
    const enabled = !DISABLED_VALUES.has(rawEnabled);
    return {
        model: env.ADVISOR_MODEL?.trim() || "opus",
        maxCalls: parseNonNegativeInt(env.ADVISOR_MAX_CALLS, DEFAULT_MAX_CALLS),
        enabled,
        transcriptEnabled: parseBoolean(env.ADVISOR_TRANSCRIPT_ENABLED, true),
        transcriptMaxChars: parseNonNegativeInt(env.ADVISOR_TRANSCRIPT_MAX_CHARS, DEFAULT_TRANSCRIPT_MAX_CHARS),
        transcriptIncludeSidechains: parseBoolean(env.ADVISOR_TRANSCRIPT_INCLUDE_SIDECHAINS, false),
        transcriptIncludeThinking: parseBoolean(env.ADVISOR_TRANSCRIPT_INCLUDE_THINKING, false),
    };
}
