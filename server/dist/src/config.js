const DEFAULT_MAX_CALLS = 5;
const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);
export function loadConfig(env = process.env) {
    const rawMax = env.ADVISOR_MAX_CALLS?.trim();
    const parsedMax = rawMax ? Number(rawMax) : DEFAULT_MAX_CALLS;
    const maxCalls = Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_MAX_CALLS;
    const rawEnabled = env.ADVISOR_ENABLED?.trim().toLowerCase() ?? "";
    return {
        model: env.ADVISOR_MODEL?.trim() || "opus",
        maxCalls,
        enabled: !DISABLED_VALUES.has(rawEnabled),
    };
}
