export function loadConfig(env = process.env) {
    const rawMax = env.ADVISOR_MAX_CALLS;
    const parsedMax = rawMax === undefined ? 5 : Number(rawMax);
    const maxCalls = Number.isFinite(parsedMax) && parsedMax >= 0 ? parsedMax : 5;
    return {
        model: env.ADVISOR_MODEL?.trim() || "opus",
        maxCalls,
        enabled: env.ADVISOR_ENABLED !== "false",
    };
}
