#!/usr/bin/env node
/**
 * bedrock-advisor PreToolUse hook.
 *
 * Claude Code invokes this script before every `mcp__advisor__consult` call.
 * Its only job is to forward the current session's transcript path into the
 * tool input so the MCP server can read the conversation history.
 *
 * Invariant: this hook must NEVER make the tool call worse than it would be
 * without the hook. On any error — bad stdin, JSON parse failure, missing
 * fields — we emit a passthrough `updatedInput` equal to the original
 * `tool_input` and exit 0. The advisor keeps working, just without
 * transcript injection. All logging is routed to stderr with a prefixed
 * one-liner; no stack traces.
 *
 * Input (JSON on stdin, from Claude Code):
 *   {
 *     "session_id": "...",
 *     "transcript_path": "/home/user/.claude/projects/<proj>/<id>.jsonl",
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "mcp__advisor__consult",
 *     "tool_input": { "context": "...", "question": "..." },
 *     ...
 *   }
 *
 * Output (JSON on stdout, exactly one line):
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "PreToolUse",
 *       "permissionDecision": "allow",
 *       "updatedInput": { ...originalToolInput, _transcript_path }
 *     }
 *   }
 */

import { readFileSync } from "node:fs";

function emit(updatedInput) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function logWarn(message) {
  try {
    process.stderr.write(`[bedrock-advisor:hook] ${message}\n`);
  } catch {
    // Never let logging failures escalate.
  }
}

let rawInput = "";
try {
  rawInput = readFileSync(0, "utf8");
} catch (err) {
  logWarn(`failed to read stdin: ${err && err.message ? err.message : err}`);
  // No input means we can't even passthrough — emit an empty allow.
  try {
    emit({});
  } catch {
    // Ignore.
  }
  process.exit(0);
}

let parsed = {};
let toolInput = {};
let transcriptPath;

try {
  parsed = JSON.parse(rawInput);
  if (parsed && typeof parsed === "object") {
    if (parsed.tool_input && typeof parsed.tool_input === "object") {
      toolInput = parsed.tool_input;
    }
    if (typeof parsed.transcript_path === "string" && parsed.transcript_path.length > 0) {
      transcriptPath = parsed.transcript_path;
    }
  }
} catch (err) {
  logWarn(`failed to parse hook input JSON: ${err && err.message ? err.message : err}`);
  // Fall through to passthrough emission below.
}

try {
  if (transcriptPath) {
    emit({ ...toolInput, _transcript_path: transcriptPath });
  } else {
    // Either the field was missing or parsing failed — passthrough unchanged.
    emit({ ...toolInput });
  }
} catch (err) {
  logWarn(`failed to emit hook output: ${err && err.message ? err.message : err}`);
}

process.exit(0);
