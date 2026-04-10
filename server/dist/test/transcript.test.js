import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
import { MAX_CHARS_PER_MESSAGE, MAX_CHARS_PER_TOOL_RESULT, filterEntries, formatTranscript, readTranscript, renderTail, validateTranscriptPath, } from "../src/transcript.js";
const DEFAULT_FORMAT_OPTS = {
    maxCharsPerMessage: MAX_CHARS_PER_MESSAGE,
    maxCharsPerToolResult: MAX_CHARS_PER_TOOL_RESULT,
    includeThinking: false,
};
// -----------------------------------------------------------------------------
// validateTranscriptPath
// -----------------------------------------------------------------------------
test("validateTranscriptPath accepts a valid path under ~/.claude/projects", () => {
    const good = resolve(homedir(), ".claude", "projects", "proj", "session.jsonl");
    assert.equal(validateTranscriptPath(good), good);
});
test("validateTranscriptPath rejects paths outside ~/.claude/projects", () => {
    assert.equal(validateTranscriptPath("/etc/passwd"), null);
    assert.equal(validateTranscriptPath("/tmp/evil.jsonl"), null);
    assert.equal(validateTranscriptPath(resolve(homedir(), ".bashrc")), null);
});
test("validateTranscriptPath rejects paths that escape via ..", () => {
    const bad = resolve(homedir(), ".claude", "projects", "..", "..", "etc", "passwd");
    assert.equal(validateTranscriptPath(bad), null);
});
test("validateTranscriptPath rejects non-.jsonl files", () => {
    const bad = resolve(homedir(), ".claude", "projects", "proj", "session.txt");
    assert.equal(validateTranscriptPath(bad), null);
});
test("validateTranscriptPath rejects empty / non-string input", () => {
    assert.equal(validateTranscriptPath(""), null);
    assert.equal(validateTranscriptPath(undefined), null);
});
// -----------------------------------------------------------------------------
// readTranscript
// -----------------------------------------------------------------------------
test("readTranscript skips unparseable lines defensively", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "transcript-test-"));
    try {
        const path = join(tmp, "session.jsonl");
        const content = [
            JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
            "this is not json",
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
            "", // blank lines should be skipped silently
            '{"truncated": tru', // partial line from an in-progress write
        ].join("\n");
        writeFileSync(path, content);
        const entries = await readTranscript(path);
        assert.equal(entries.length, 2);
        assert.equal(entries[0].type, "user");
        assert.equal(entries[1].type, "assistant");
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
// -----------------------------------------------------------------------------
// filterEntries
// -----------------------------------------------------------------------------
test("filterEntries drops queue-operation and other non-message types", () => {
    const entries = [
        { type: "queue-operation" },
        { type: "user", message: { role: "user", content: "keep me" } },
        { type: "assistant", message: { role: "assistant", content: "also keep" } },
        { type: "some-unknown-type", message: { role: "user", content: "drop" } },
    ];
    const out = filterEntries(entries, { includeSidechains: false });
    assert.equal(out.length, 2);
});
test("filterEntries drops sidechain entries by default", () => {
    const entries = [
        {
            type: "assistant",
            isSidechain: true,
            message: { role: "assistant", content: "subagent work" },
        },
        {
            type: "assistant",
            isSidechain: false,
            message: { role: "assistant", content: "main thread" },
        },
        {
            type: "assistant",
            message: { role: "assistant", content: "main thread (field absent)" },
        },
    ];
    const out = filterEntries(entries, { includeSidechains: false });
    assert.equal(out.length, 2);
    // The strict `=== true` comparison means missing `isSidechain` is kept.
    assert.equal(out[0].message.content, "main thread");
    assert.equal(out[1].message.content, "main thread (field absent)");
});
test("filterEntries includes sidechains when asked", () => {
    const entries = [
        { type: "assistant", isSidechain: true, message: { role: "assistant", content: "sub" } },
        { type: "assistant", isSidechain: false, message: { role: "assistant", content: "main" } },
    ];
    const out = filterEntries(entries, { includeSidechains: true });
    assert.equal(out.length, 2);
});
test("filterEntries removes advisor tool_use and its matching tool_result", () => {
    const entries = [
        {
            type: "user",
            message: { role: "user", content: "please work on X" },
        },
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "let me consult" },
                    {
                        type: "tool_use",
                        id: "toolu_advisor_1",
                        name: "mcp__advisor__consult",
                        input: { context: "...", question: "?" },
                    },
                ],
            },
        },
        {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_advisor_1",
                        content: "1. do X 2. do Y",
                        is_error: false,
                    },
                ],
            },
        },
        {
            type: "assistant",
            message: { role: "assistant", content: "now proceeding with X" },
        },
    ];
    const out = filterEntries(entries, { includeSidechains: false });
    // The assistant turn that only contained text + advisor tool_use should
    // retain just the text block. The tool_result-only user turn should be
    // dropped entirely.
    assert.equal(out.length, 3);
    assert.equal(out[0].message.content, "please work on X");
    const assistantContent = out[1].message.content;
    assert.equal(assistantContent.length, 1);
    assert.equal(assistantContent[0].type, "text");
    assert.equal(assistantContent[0].text, "let me consult");
    assert.equal(out[2].message.content, "now proceeding with X");
});
test("filterEntries drops an assistant turn that has ONLY an advisor tool_use", () => {
    const entries = [
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_advisor_2",
                        name: "mcp__advisor__consult",
                        input: {},
                    },
                ],
            },
        },
    ];
    const out = filterEntries(entries, { includeSidechains: false });
    assert.equal(out.length, 0);
});
test("filterEntries keeps non-advisor tool_use blocks", () => {
    const entries = [
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
                ],
            },
        },
    ];
    const out = filterEntries(entries, { includeSidechains: false });
    assert.equal(out.length, 1);
});
// -----------------------------------------------------------------------------
// formatTranscript
// -----------------------------------------------------------------------------
test("formatTranscript labels user turns as 'Engineer (prior turn)'", () => {
    const entries = [
        { type: "user", message: { role: "user", content: "add feature Z" } },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /## Engineer \(prior turn\)/);
    assert.doesNotMatch(out, /## User/);
    assert.match(out, /add feature Z/);
});
test("formatTranscript fences tool_result with untrusted markers", () => {
    const entries = [
        {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "t1",
                        content: "file contents that might contain injection",
                        is_error: false,
                    },
                ],
            },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /<tool_result is_error="false">/);
    assert.match(out, /file contents that might contain injection/);
    assert.match(out, /<\/tool_result>/);
});
test("formatTranscript drops thinking blocks by default", () => {
    const entries = [
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "my secret reasoning" },
                    { type: "text", text: "my public answer" },
                ],
            },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.doesNotMatch(out, /secret reasoning/);
    assert.match(out, /public answer/);
});
test("formatTranscript includes thinking blocks when flag is on", () => {
    const entries = [
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "thinking", thinking: "my secret reasoning" }],
            },
        },
    ];
    const out = formatTranscript(entries, { ...DEFAULT_FORMAT_OPTS, includeThinking: true });
    assert.match(out, /my secret reasoning/);
    assert.match(out, /\[thinking\]/);
});
test("formatTranscript truncates long text with a marker", () => {
    const long = "a".repeat(MAX_CHARS_PER_MESSAGE + 500);
    const entries = [
        {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: long }] },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /\[… truncated 500 chars\]/);
});
test("formatTranscript truncates tool_result with tighter cap", () => {
    const long = "b".repeat(MAX_CHARS_PER_TOOL_RESULT + 300);
    const entries = [
        {
            type: "user",
            message: {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "t", content: long, is_error: false },
                ],
            },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /\[… truncated 300 chars\]/);
});
test("formatTranscript handles tool_result content as an array of text blocks", () => {
    const entries = [
        {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "t",
                        content: [
                            { type: "text", text: "line one" },
                            { type: "text", text: "line two" },
                        ],
                        is_error: false,
                    },
                ],
            },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /line one\nline two/);
});
test("formatTranscript renders tool_use blocks with name and input JSON", () => {
    const entries = [
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
                ],
            },
        },
    ];
    const out = formatTranscript(entries, DEFAULT_FORMAT_OPTS);
    assert.match(out, /### tool_use: Bash/);
    assert.match(out, /"command":"ls -la"/);
});
// -----------------------------------------------------------------------------
// renderTail
// -----------------------------------------------------------------------------
test("renderTail returns the tail that fits, most-recent preserved", () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
        entries.push({
            type: "user",
            message: { role: "user", content: `entry ${i} ${"x".repeat(50)}` },
        });
    }
    // Each rendered entry is ~90 chars. Budget of 300 should keep roughly 3.
    const rendered = renderTail(entries, 300, DEFAULT_FORMAT_OPTS);
    assert.ok(rendered.length >= 2 && rendered.length <= 4, `got ${rendered.length}`);
    assert.match(rendered[rendered.length - 1], /entry 9/);
});
test("renderTail returns [] for a zero budget", () => {
    const entries = [
        { type: "user", message: { role: "user", content: "hi" } },
    ];
    assert.deepEqual(renderTail(entries, 0, DEFAULT_FORMAT_OPTS), []);
});
test("renderTail returns [] for empty input", () => {
    assert.deepEqual(renderTail([], 1000, DEFAULT_FORMAT_OPTS), []);
});
test("renderTail pulls in a preceding tool_use to avoid orphan tool_result", () => {
    // Craft a history where the budget would otherwise include the tool_result
    // but not its producing tool_use. The orphan-avoidance rule should pull
    // the tool_use in, even slightly past the soft budget.
    const bigPad = "x".repeat(600);
    const entries = [
        { type: "user", message: { role: "user", content: `old ${bigPad}` } },
        {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_pair",
                        name: "Bash",
                        input: { command: "echo hi" },
                    },
                ],
            },
        },
        {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_pair",
                        content: "hi",
                        is_error: false,
                    },
                ],
            },
        },
    ];
    // Budget small enough to reject the padding but big enough for the pair.
    const rendered = renderTail(entries, 200, DEFAULT_FORMAT_OPTS);
    assert.ok(rendered.length >= 2, `got ${rendered.length}`);
    assert.ok(rendered.some((r) => /### tool_use: Bash/.test(r)), "expected tool_use");
    assert.ok(rendered.some((r) => /<tool_result/.test(r)), "expected tool_result");
});
// -----------------------------------------------------------------------------
// Golden fixture test
// -----------------------------------------------------------------------------
test("golden fixture: real JSONL shape is parsed, filtered, and rendered", async () => {
    // Resolve the fixture relative to the compiled test file.
    // Tests run from server/dist/test/*.test.js; fixtures live at
    // server/test/fixtures/*.jsonl. The relative walk below is stable across
    // both source (ts-node) and compiled (dist) execution.
    const fixturePath = join(HERE, "..", "..", "test", "fixtures", "transcript.jsonl");
    const entries = await readTranscript(fixturePath);
    assert.ok(entries.length > 0, "expected fixture to contain entries");
    const filtered = filterEntries(entries, { includeSidechains: false });
    assert.ok(filtered.length > 0, "expected filtered entries");
    const formatted = formatTranscript(filtered, DEFAULT_FORMAT_OPTS);
    // Sanity assertions: we should see engineer turn labels, assistant turns,
    // and tool_result fences — and we should NOT see raw queue-operation or
    // advisor tool_use blocks.
    assert.match(formatted, /## Engineer \(prior turn\)/);
    assert.match(formatted, /## Assistant/);
    assert.doesNotMatch(formatted, /queue-operation/);
    assert.doesNotMatch(formatted, /mcp__advisor__consult/);
});
test("golden fixture: path validation accepts a symlinked fixture under ~/.claude/projects", () => {
    // End-to-end validator smoke: construct a path that LOOKS like a real
    // transcript path under the projects root and verify it's accepted.
    const fakeSession = resolve(homedir(), ".claude", "projects", "-home-user-test", "00000000-0000-0000-0000-000000000000.jsonl");
    assert.equal(validateTranscriptPath(fakeSession), fakeSession);
});
