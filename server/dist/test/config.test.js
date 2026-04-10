import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
test("loadConfig uses defaults when nothing is set", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.model, "opus");
    assert.equal(cfg.maxCalls, 5);
    assert.equal(cfg.enabled, true);
});
test("loadConfig passes ADVISOR_MODEL through, trimmed", () => {
    assert.equal(loadConfig({ ADVISOR_MODEL: "  claude-opus-4-6 " }).model, "claude-opus-4-6");
});
test("loadConfig falls back to default model on blank or whitespace-only ADVISOR_MODEL", () => {
    assert.equal(loadConfig({ ADVISOR_MODEL: "" }).model, "opus");
    assert.equal(loadConfig({ ADVISOR_MODEL: "   " }).model, "opus");
});
test("loadConfig parses a valid ADVISOR_MAX_CALLS", () => {
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "12" }).maxCalls, 12);
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "0" }).maxCalls, 0);
});
test("loadConfig treats empty or whitespace ADVISOR_MAX_CALLS as default, not zero", () => {
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "" }).maxCalls, 5);
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "   " }).maxCalls, 5);
});
test("loadConfig rejects non-integer and malformed ADVISOR_MAX_CALLS", () => {
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "1.5" }).maxCalls, 5);
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "abc" }).maxCalls, 5);
    assert.equal(loadConfig({ ADVISOR_MAX_CALLS: "-1" }).maxCalls, 5);
});
test("loadConfig ADVISOR_ENABLED disables on the expected casing matrix", () => {
    for (const value of ["false", "FALSE", "False", "0", "no", "NO", "off", " off "]) {
        assert.equal(loadConfig({ ADVISOR_ENABLED: value }).enabled, false, `expected ${JSON.stringify(value)} to disable`);
    }
});
test("loadConfig ADVISOR_ENABLED leaves the tool enabled otherwise", () => {
    for (const value of [undefined, "", "true", "yes", "1", "on"]) {
        assert.equal(loadConfig(value === undefined ? {} : { ADVISOR_ENABLED: value }).enabled, true, `expected ${JSON.stringify(value)} to leave enabled`);
    }
});
test("loadConfig transcript defaults: enabled, 24k chars, no sidechains, no thinking", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.transcriptEnabled, true);
    assert.equal(cfg.transcriptMaxChars, 24_000);
    assert.equal(cfg.transcriptIncludeSidechains, false);
    assert.equal(cfg.transcriptIncludeThinking, false);
});
test("loadConfig ADVISOR_TRANSCRIPT_ENABLED disables on the expected values", () => {
    for (const value of ["false", "FALSE", "0", "no", "off"]) {
        assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_ENABLED: value }).transcriptEnabled, false, `expected ${JSON.stringify(value)} to disable`);
    }
});
test("loadConfig parses ADVISOR_TRANSCRIPT_MAX_CHARS", () => {
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_MAX_CHARS: "1000" }).transcriptMaxChars, 1000);
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_MAX_CHARS: "0" }).transcriptMaxChars, 0);
});
test("loadConfig rejects malformed ADVISOR_TRANSCRIPT_MAX_CHARS and falls back to default", () => {
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_MAX_CHARS: "abc" }).transcriptMaxChars, 24_000);
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_MAX_CHARS: "-1" }).transcriptMaxChars, 24_000);
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_MAX_CHARS: "1.5" }).transcriptMaxChars, 24_000);
});
test("loadConfig ADVISOR_TRANSCRIPT_INCLUDE_SIDECHAINS opts in", () => {
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_INCLUDE_SIDECHAINS: "true" }).transcriptIncludeSidechains, true);
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_INCLUDE_SIDECHAINS: "false" }).transcriptIncludeSidechains, false);
});
test("loadConfig ADVISOR_TRANSCRIPT_INCLUDE_THINKING opts in", () => {
    assert.equal(loadConfig({ ADVISOR_TRANSCRIPT_INCLUDE_THINKING: "true" }).transcriptIncludeThinking, true);
});
