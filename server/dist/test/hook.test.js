import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
// From server/dist/test/hook.test.js walk to server/ then up to the plugin
// root, and into hooks/inject-transcript.mjs. The same relative walk works
// from source (server/test/hook.test.ts) because it goes through `../..`.
const HOOK_PATH = resolve(HERE, "..", "..", "..", "hooks", "inject-transcript.mjs");
/** Runs the hook with the given stdin payload and returns its output. */
function runHook(stdin) {
    const result = spawnSync("node", [HOOK_PATH], {
        input: stdin,
        encoding: "utf8",
        timeout: 5_000,
    });
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.status,
    };
}
test("hook: forwards transcript_path into updatedInput._transcript_path", () => {
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__advisor__consult",
        transcript_path: "/home/user/.claude/projects/proj/abc.jsonl",
        tool_input: { context: "hello", question: "?" },
    });
    const { stdout, code } = runHook(payload);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(parsed.hookSpecificOutput.updatedInput.context, "hello");
    assert.equal(parsed.hookSpecificOutput.updatedInput.question, "?");
    assert.equal(parsed.hookSpecificOutput.updatedInput._transcript_path, "/home/user/.claude/projects/proj/abc.jsonl");
});
test("hook: exits 0 with a passthrough when transcript_path is missing", () => {
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__advisor__consult",
        tool_input: { context: "hello" },
    });
    const { stdout, code } = runHook(payload);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.updatedInput.context, "hello");
    assert.equal(parsed.hookSpecificOutput.updatedInput._transcript_path, undefined);
});
test("hook: exits 0 with a passthrough when stdin is not valid JSON", () => {
    const { stdout, code } = runHook("this is not json");
    assert.equal(code, 0);
    // Must still emit a valid JSON line with an allow decision.
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
});
test("hook: exits 0 with a passthrough on empty stdin", () => {
    const { stdout, code } = runHook("");
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
});
test("hook: preserves all original tool_input fields", () => {
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        transcript_path: "/home/user/.claude/projects/proj/abc.jsonl",
        tool_input: {
            context: "ctx",
            question: "q",
            someUnrelatedField: "value",
        },
    });
    const { stdout } = runHook(payload);
    const parsed = JSON.parse(stdout);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.equal(updated.context, "ctx");
    assert.equal(updated.question, "q");
    assert.equal(updated.someUnrelatedField, "value");
    assert.equal(updated._transcript_path, "/home/user/.claude/projects/proj/abc.jsonl");
});
test("hook: ignores non-string transcript_path (defensive)", () => {
    const payload = JSON.stringify({
        transcript_path: 12345, // wrong type
        tool_input: { context: "hi" },
    });
    const { stdout, code } = runHook(payload);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.updatedInput._transcript_path, undefined);
    assert.equal(parsed.hookSpecificOutput.updatedInput.context, "hi");
});
