import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";
/**
 * Transcript injection for the advisor.
 *
 * The MCP server has no direct access to the current Claude Code session's
 * conversation. A PreToolUse hook bundled with the plugin injects the
 * session's `transcript_path` into the tool call; this module reads the
 * resulting JSONL file, filters and truncates it, and produces a string
 * that `buildPrompt` appends to the advisor prompt as untrusted evidence.
 *
 * Design notes (see /root/.claude/plans/dynamic-riding-tiger.md):
 *   - Never throws into the handler path — callers must tolerate null.
 *   - Path reads are restricted to `~/.claude/projects/**.jsonl`.
 *   - Prior `mcp__advisor__consult` tool_use/tool_result pairs are filtered
 *     out to avoid echo chambers.
 *   - Tool-result content is fenced with XML-ish markers so the advisor's
 *     system prompt can label it as untrusted.
 */
export const MAX_CHARS_PER_MESSAGE = 2_000;
export const MAX_CHARS_PER_TOOL_RESULT = 1_500;
/** Soft-overrun allowance when a tool_result pulls in its preceding tool_use past budget. */
const BUDGET_OVERRUN_GRACE = 0.1;
/**
 * Defensive cap on lines parsed from a transcript. Even a 24k-char budget
 * can't fit anywhere near this many entries, so parsing the prefix is pure
 * waste on pathologically long sessions.
 */
const MAX_LINES_READ = 10_000;
/** MCP tool name for the advisor itself — filtered to avoid echo chambers. */
const ADVISOR_TOOL_NAME = "mcp__advisor__consult";
function asBlock(x) {
    return x && typeof x === "object" ? x : null;
}
// -----------------------------------------------------------------------------
// Path validation
// -----------------------------------------------------------------------------
/**
 * Returns a sanitized absolute path under `~/.claude/projects/` ending in
 * `.jsonl`, or null if rejected. Defense in depth against a prompt-injected
 * `_transcript_path` override.
 */
export function validateTranscriptPath(input) {
    if (typeof input !== "string" || input.length === 0)
        return null;
    const absolute = resolve(input);
    if (extname(absolute) !== ".jsonl")
        return null;
    const projectsRoot = resolve(homedir(), ".claude", "projects") + sep;
    if (!absolute.startsWith(projectsRoot))
        return null;
    return absolute;
}
// -----------------------------------------------------------------------------
// File read
// -----------------------------------------------------------------------------
/**
 * Unparseable lines (e.g. a partial trailing line from an in-progress write)
 * are skipped silently — the next advisor call picks them up.
 */
export async function readTranscript(path) {
    const raw = await readFile(path, "utf8");
    const allLines = raw.split("\n");
    const lines = allLines.length > MAX_LINES_READ ? allLines.slice(-MAX_LINES_READ) : allLines;
    const out = [];
    for (const line of lines) {
        if (line.length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object") {
                out.push(parsed);
            }
        }
        catch {
            // Skip partial / malformed lines.
        }
    }
    return out;
}
// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------
/**
 * Filters entries to the set the advisor should see:
 *   - keeps only user/assistant messages (drops queue-operation, etc.)
 *   - drops sidechain (sub-agent) entries unless explicitly included
 *   - drops both halves of any prior `mcp__advisor__consult` pair
 *
 * Entries are returned by reference when no blocks were dropped — only
 * entries that actually lost blocks get a shallow copy.
 */
export function filterEntries(entries, opts) {
    const advisorToolUseIds = new Set();
    const out = [];
    for (const entry of entries) {
        if (entry.type !== "user" && entry.type !== "assistant")
            continue;
        if (!opts.includeSidechains && entry.isSidechain === true)
            continue;
        const content = entry.message?.content;
        if (typeof content === "string") {
            out.push(entry);
            continue;
        }
        if (!Array.isArray(content))
            continue;
        // First pass: collect advisor tool_use ids so we can drop their
        // tool_result counterparts alongside the tool_use itself.
        for (const raw of content) {
            const b = asBlock(raw);
            if (b?.type === "tool_use" && b.name === ADVISOR_TOOL_NAME) {
                const id = b.id;
                if (typeof id === "string")
                    advisorToolUseIds.add(id);
            }
        }
        // Second pass: keep everything that isn't an advisor block.
        const keptBlocks = [];
        for (const raw of content) {
            const b = asBlock(raw);
            if (!b)
                continue;
            if (b.type === "tool_use" && b.name === ADVISOR_TOOL_NAME)
                continue;
            if (b.type === "tool_result") {
                const id = b.tool_use_id;
                if (typeof id === "string" && advisorToolUseIds.has(id))
                    continue;
            }
            keptBlocks.push(raw);
        }
        if (keptBlocks.length === 0)
            continue;
        if (keptBlocks.length === content.length) {
            out.push(entry);
            continue;
        }
        out.push({ ...entry, message: { ...entry.message, content: keptBlocks } });
    }
    return out;
}
// -----------------------------------------------------------------------------
// Tail selection + rendering (single pass)
// -----------------------------------------------------------------------------
/**
 * Walks entries from the tail backward, rendering each as it goes, and
 * returns the suffix (in chronological order) whose total rendered size
 * fits within `charBudget`. An orphaned `tool_result` at the budget
 * boundary pulls in its producing `tool_use` even if that pushes slightly
 * past the soft budget.
 *
 * Single-pass render: each kept entry is rendered exactly once, and
 * nothing outside the kept tail is rendered at all. On long sessions this
 * turns O(N) render work into O(kept) — the whole point of the refactor
 * that collapsed the old `selectTailWithinBudget` + `formatTranscript`
 * pair.
 */
export function renderTail(entries, charBudget, opts) {
    if (charBudget <= 0 || entries.length === 0)
        return [];
    const hardCap = Math.floor(charBudget * (1 + BUDGET_OVERRUN_GRACE));
    const selected = [];
    let total = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const text = renderEntry(entries[i], opts);
        if (total + text.length > charBudget) {
            // Orphan rescue: if the most recently selected entry is a tool_result
            // whose producing tool_use lives in this entry, pull this entry in
            // even though we're over budget (up to the soft-cap grace).
            const newest = selected[selected.length - 1];
            if (newest &&
                total + text.length <= hardCap &&
                earlierContainsToolUseFor(entries[i], entries[newest.index])) {
                selected.push({ index: i, text });
            }
            break;
        }
        selected.push({ index: i, text });
        total += text.length;
    }
    return selected.reverse().map((s) => s.text);
}
/**
 * True if `earlier` contains a `tool_use` whose id matches a
 * `tool_result.tool_use_id` in `later`. Used once per `renderTail`
 * invocation at the budget boundary, not in a hot loop.
 */
function earlierContainsToolUseFor(earlier, later) {
    const laterContent = later.message?.content;
    const earlierContent = earlier.message?.content;
    if (!Array.isArray(laterContent) || !Array.isArray(earlierContent))
        return false;
    const laterToolResultIds = new Set();
    for (const raw of laterContent) {
        const b = asBlock(raw);
        if (b?.type === "tool_result") {
            const id = b.tool_use_id;
            if (typeof id === "string")
                laterToolResultIds.add(id);
        }
    }
    if (laterToolResultIds.size === 0)
        return false;
    for (const raw of earlierContent) {
        const b = asBlock(raw);
        if (b?.type === "tool_use") {
            const id = b.id;
            if (typeof id === "string" && laterToolResultIds.has(id))
                return true;
        }
    }
    return false;
}
// -----------------------------------------------------------------------------
// Per-entry rendering
// -----------------------------------------------------------------------------
/**
 * Renders a single entry with injection-safe markers. Tool results are
 * fenced so the advisor's system prompt can disclaim them as untrusted.
 * Exported for tests; the hot path goes through `renderTail`.
 */
export function renderEntry(entry, opts) {
    const role = entry.message?.role;
    const content = entry.message?.content;
    const heading = role === "user" ? "## Engineer (prior turn)" : "## Assistant";
    const parts = [heading];
    if (typeof content === "string") {
        parts.push(truncate(content, opts.maxCharsPerMessage));
    }
    else if (Array.isArray(content)) {
        for (const raw of content) {
            const b = asBlock(raw);
            if (!b)
                continue;
            switch (b.type) {
                case "text": {
                    const text = b.text;
                    if (typeof text === "string") {
                        parts.push(truncate(text, opts.maxCharsPerMessage));
                    }
                    break;
                }
                case "thinking": {
                    if (!opts.includeThinking)
                        break;
                    const thinking = b.thinking;
                    if (typeof thinking === "string") {
                        parts.push("[thinking]");
                        parts.push(truncate(thinking, opts.maxCharsPerMessage));
                    }
                    break;
                }
                case "tool_use": {
                    const tu = b;
                    const name = typeof tu.name === "string" ? tu.name : "unknown";
                    parts.push(`### tool_use: ${name}`);
                    // `tu.input` came from JSON.parse via readTranscript, so it's
                    // guaranteed acyclic — JSON.stringify cannot throw here.
                    parts.push(`input: ${truncate(JSON.stringify(tu.input ?? {}), opts.maxCharsPerMessage)}`);
                    break;
                }
                case "tool_result": {
                    const tr = b;
                    const text = toolResultToText(tr.content);
                    const isError = tr.is_error === true ? "true" : "false";
                    parts.push(`<tool_result is_error="${isError}">`);
                    parts.push(truncate(text, opts.maxCharsPerToolResult));
                    parts.push("</tool_result>");
                    break;
                }
            }
        }
    }
    return parts.join("\n");
}
/**
 * Thin test helper that renders a list of entries and joins them with
 * blank-line separators. The production hot path calls `renderTail`
 * directly and joins the result itself.
 */
export function formatTranscript(entries, opts) {
    return entries.map((e) => renderEntry(e, opts)).join("\n\n");
}
/** Normalizes a `tool_result.content` (string or array of text blocks) to a plain string. */
function toolResultToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        const pieces = [];
        for (const raw of content) {
            const b = asBlock(raw);
            if (b?.type === "text") {
                const text = b.text;
                if (typeof text === "string")
                    pieces.push(text);
            }
        }
        return pieces.join("\n");
    }
    return "";
}
function truncate(s, cap) {
    if (s.length <= cap)
        return s;
    return s.slice(0, cap) + `\n[… truncated ${s.length - cap} chars]`;
}
