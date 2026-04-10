import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Transcript injection for the advisor.
 *
 * The MCP server has no direct access to the current Claude Code session's
 * conversation. A PreToolUse hook bundled with the plugin injects the
 * session's `transcript_path` into the tool call; this module reads the
 * resulting JSONL file, filters and truncates it, and renders a string
 * that `buildPrompt` appends to the advisor prompt as untrusted evidence.
 *
 * Design constraints (see /root/.claude/plans/dynamic-riding-tiger.md):
 *   - Must degrade cleanly — never throw into the handler path.
 *   - Path reads are restricted to `~/.claude/projects/**.jsonl`.
 *   - Prior `mcp__advisor__consult` tool_use/tool_result pairs are filtered
 *     out to avoid echo chambers and reclaim budget.
 *   - Budgets are conservative to keep per-call cost sane; see README.
 *   - Tool-result content is fenced with XML-ish markers so the advisor's
 *     system prompt can label it as untrusted.
 */

/** Per-block char cap for text and thinking blocks. */
export const MAX_CHARS_PER_MESSAGE = 2_000;
/** Tighter cap for tool_result content (file reads, shell output dominate bloat). */
export const MAX_CHARS_PER_TOOL_RESULT = 1_500;
/** Soft-overrun allowance when a tool_result pulls in its preceding tool_use past budget. */
const BUDGET_OVERRUN_GRACE = 0.1;

/** MCP tool name for the advisor itself — filtered to avoid echo chambers. */
const ADVISOR_TOOL_NAME = "mcp__advisor__consult";

/**
 * Shape of a single parsed JSONL line. We only model the fields we consume;
 * everything else stays as `unknown` and is ignored.
 */
export interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
  [k: string]: unknown;
}

export interface FilterOptions {
  includeSidechains: boolean;
}

export interface FormatOptions {
  maxCharsPerMessage: number;
  maxCharsPerToolResult: number;
  includeThinking: boolean;
}

/**
 * Validates a hook-provided transcript path. Returns a resolved absolute path
 * under `~/.claude/projects/` ending in `.jsonl`, or null if rejected.
 *
 * Defense in depth: even if a prompt-injected `_transcript_path` lands in the
 * tool input (hook bypass, misconfiguration), this check prevents the server
 * from reading arbitrary files.
 */
export function validateTranscriptPath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  let absolute: string;
  try {
    absolute = resolve(input);
  } catch {
    return null;
  }
  if (!absolute.endsWith(".jsonl")) return null;
  const projectsRoot = resolve(homedir(), ".claude", "projects") + sep;
  if (!absolute.startsWith(projectsRoot)) return null;
  return absolute;
}

/**
 * Reads a JSONL transcript file and returns one entry per parseable line.
 * Unparseable lines (e.g. a partial trailing line from an in-progress write)
 * are skipped silently rather than aborting the read.
 */
export async function readTranscript(path: string): Promise<RawEntry[]> {
  const raw = await readFile(path, "utf8");
  const out: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as RawEntry);
      }
    } catch {
      // Skip partial / malformed lines — next call will pick them up.
    }
  }
  return out;
}

/**
 * Filters entries to the set the advisor should see:
 *   - keeps only user/assistant message entries (drops `queue-operation`, etc.)
 *   - drops sidechain (sub-agent) entries unless explicitly included
 *   - drops both halves of any prior `mcp__advisor__consult` tool_use/tool_result pair
 *
 * The self-reference filter walks the entries linearly: an assistant message
 * whose content consists only of tool_use blocks targeting the advisor is
 * dropped, and its tool_use ids are remembered so the matching tool_result
 * entries (on subsequent user turns) can be dropped too.
 */
export function filterEntries(entries: RawEntry[], opts: FilterOptions): RawEntry[] {
  const advisorToolUseIds = new Set<string>();
  const out: RawEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!opts.includeSidechains && entry.isSidechain === true) continue;

    const content = entry.message?.content;

    // String content (simple user prompt) always passes.
    if (typeof content === "string") {
      out.push(entry);
      continue;
    }
    if (!Array.isArray(content)) continue;

    // Track advisor tool_use ids so we can drop their tool_result counterparts.
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use" &&
        (block as { name?: string }).name === ADVISOR_TOOL_NAME
      ) {
        const id = (block as { id?: string }).id;
        if (typeof id === "string") advisorToolUseIds.add(id);
      }
    }

    // Strip advisor-related blocks from the content; drop the entry if empty.
    const keptBlocks = content.filter((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as { type?: string; name?: string; tool_use_id?: string };
      if (b.type === "tool_use" && b.name === ADVISOR_TOOL_NAME) return false;
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && advisorToolUseIds.has(b.tool_use_id)) {
        return false;
      }
      return true;
    });

    if (keptBlocks.length === 0) continue;

    // Rebuild a shallow copy with the filtered content; don't mutate input.
    out.push({
      ...entry,
      message: { ...entry.message, content: keptBlocks },
    });
  }

  return out;
}

/**
 * Walks entries from the tail backward, accumulating rendered size, and
 * returns the suffix that fits within `charBudget`. If the newly included
 * entry would leave an orphaned `tool_result` (i.e. its producing `tool_use`
 * in a preceding assistant turn didn't make the cut), the preceding entry is
 * pulled in even if it pushes slightly over budget.
 *
 * Returns entries in chronological order.
 */
export function selectTailWithinBudget(
  entries: RawEntry[],
  charBudget: number,
  formatOpts: FormatOptions,
): RawEntry[] {
  if (charBudget <= 0 || entries.length === 0) return [];

  // Pre-render each entry in isolation so we can measure size cheaply.
  const rendered = entries.map((e) => renderEntry(e, formatOpts));
  const selectedIndexes: number[] = [];
  let total = 0;
  const hardCap = Math.floor(charBudget * (1 + BUDGET_OVERRUN_GRACE));

  for (let i = entries.length - 1; i >= 0; i--) {
    const size = rendered[i]!.length;
    if (total + size > charBudget) {
      // No more room. But: if the first entry we already included was a
      // tool_result, try to also include this entry if it's the matching
      // tool_use and we're still within the soft-overrun grace.
      if (
        selectedIndexes.length > 0 &&
        entryProducesOrphanWith(entries[selectedIndexes[selectedIndexes.length - 1]!]!, entries[i]!) &&
        total + size <= hardCap
      ) {
        selectedIndexes.push(i);
        total += size;
      }
      break;
    }
    selectedIndexes.push(i);
    total += size;
  }

  return selectedIndexes.reverse().map((i) => entries[i]!);
}

/**
 * Returns true if `earlier` contains a `tool_use` whose id matches a
 * `tool_result.tool_use_id` in `later`. Used to avoid stranding a tool_result
 * without its producing tool_use when the budget cut falls mid-pair.
 */
function entryProducesOrphanWith(later: RawEntry, earlier: RawEntry): boolean {
  const laterContent = later.message?.content;
  const earlierContent = earlier.message?.content;
  if (!Array.isArray(laterContent) || !Array.isArray(earlierContent)) return false;

  const laterToolResultIds = new Set<string>();
  for (const block of laterContent) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; tool_use_id?: string };
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        laterToolResultIds.add(b.tool_use_id);
      }
    }
  }
  if (laterToolResultIds.size === 0) return false;

  for (const block of earlierContent) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; id?: string };
      if (b.type === "tool_use" && typeof b.id === "string" && laterToolResultIds.has(b.id)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Renders a single entry as a plain-text block with injection-safe markers.
 * Tool results are fenced so the advisor's system prompt can disclaim them.
 */
function renderEntry(entry: RawEntry, opts: FormatOptions): string {
  const role = entry.message?.role;
  const content = entry.message?.content;

  const heading = role === "user" ? "## Engineer (prior turn)" : "## Assistant";
  const parts: string[] = [heading];

  if (typeof content === "string") {
    parts.push(truncate(content, opts.maxCharsPerMessage));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as {
        type?: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: unknown;
        content?: unknown;
        is_error?: boolean;
      };
      switch (b.type) {
        case "text": {
          if (typeof b.text === "string") {
            parts.push(truncate(b.text, opts.maxCharsPerMessage));
          }
          break;
        }
        case "thinking": {
          if (opts.includeThinking && typeof b.thinking === "string") {
            parts.push("[thinking]");
            parts.push(truncate(b.thinking, opts.maxCharsPerMessage));
          }
          break;
        }
        case "tool_use": {
          const name = typeof b.name === "string" ? b.name : "unknown";
          let inputStr: string;
          try {
            inputStr = JSON.stringify(b.input ?? {});
          } catch {
            inputStr = "<unserializable>";
          }
          parts.push(`### tool_use: ${name}`);
          parts.push(`input: ${truncate(inputStr, opts.maxCharsPerMessage)}`);
          break;
        }
        case "tool_result": {
          const text = toolResultToText(b.content);
          const isError = b.is_error === true ? "true" : "false";
          parts.push(`<tool_result is_error="${isError}">`);
          parts.push(truncate(text, opts.maxCharsPerToolResult));
          parts.push("</tool_result>");
          break;
        }
        default:
          // Unknown block types are silently dropped.
          break;
      }
    }
  }

  // If a content array had only filtered-out blocks (e.g. just thinking), we
  // still return the heading — but the entry would already have been dropped
  // by filterEntries in that case, so it won't reach here for advisor calls.
  return parts.join("\n");
}

/**
 * Normalizes a `tool_result.content` to a plain string. It may be a string
 * or an array of `{type: "text", text}` blocks depending on the producer.
 */
function toolResultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") pieces.push(b.text);
      }
    }
    return pieces.join("\n");
  }
  return "";
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const dropped = s.length - cap;
  return s.slice(0, cap) + `\n[… truncated ${dropped} chars]`;
}

/**
 * Renders the final transcript string that `buildPrompt` will embed under
 * the "Recent conversation" section. Entries should already be filtered and
 * selected; this just emits them with blank-line separators.
 */
export function formatTranscript(entries: RawEntry[], opts: FormatOptions): string {
  if (entries.length === 0) return "";
  return entries.map((e) => renderEntry(e, opts)).join("\n\n");
}
