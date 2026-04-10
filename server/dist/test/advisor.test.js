import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { runAdvisor } from "../src/advisor.js";
/**
 * Builds a fake ChildProcess that records stdin writes and kill signals and
 * lets the test drive stdout/stderr/close/error events deterministically.
 */
function makeFakeChild() {
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinChunks = [];
    const killSignals = [];
    const stdin = new Writable({
        write(chunk, _enc, cb) {
            stdinChunks.push(chunk.toString());
            cb();
        },
    });
    Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill: (signal) => {
            killSignals.push(signal);
            return true;
        },
    });
    return {
        child: emitter,
        stdinChunks,
        emitStdout: (t) => stdout.emit("data", Buffer.from(t)),
        emitStderr: (t) => stderr.emit("data", Buffer.from(t)),
        emitStdinError: (err) => stdin.emit("error", err),
        close: (code) => emitter.emit("close", code),
        error: (err) => emitter.emit("error", err),
        killSignals,
    };
}
test("runAdvisor spawns claude with -p --model <model> and pipes the prompt via stdin", async () => {
    const fake = makeFakeChild();
    let capturedCommand = "";
    let capturedArgs = [];
    const spawner = (command, args) => {
        capturedCommand = command;
        capturedArgs = args;
        return fake.child;
    };
    const promise = runAdvisor({
        model: "opus",
        prompt: "hello advisor",
        spawner,
    });
    fake.emitStdout("response text\n");
    fake.close(0);
    const result = await promise;
    assert.equal(capturedCommand, "claude");
    assert.deepEqual(capturedArgs, ["-p", "--model", "opus"]);
    assert.equal(fake.stdinChunks.join(""), "hello advisor");
    assert.equal(result, "response text");
});
test("runAdvisor rejects with stderr content on non-zero exit", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
    });
    fake.emitStderr("auth error");
    fake.close(1);
    await assert.rejects(promise, /claude -p exited 1: auth error/);
});
test("runAdvisor rejects when the subprocess emits an error event", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
    });
    fake.error(new Error("ENOENT"));
    await assert.rejects(promise, /ENOENT/);
});
test("runAdvisor times out and rejects if the subprocess never closes", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    await assert.rejects(runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
        timeoutMs: 20,
    }), /timed out after 20ms/);
});
test("runAdvisor passes a custom model through to argv", async () => {
    const fake = makeFakeChild();
    let capturedArgs = [];
    const spawner = (_c, args) => {
        capturedArgs = args;
        return fake.child;
    };
    const promise = runAdvisor({
        model: "claude-opus-4-6",
        prompt: "p",
        spawner,
    });
    fake.emitStdout("ok");
    fake.close(0);
    await promise;
    assert.deepEqual(capturedArgs, ["-p", "--model", "claude-opus-4-6"]);
});
test("runAdvisor rejects on stdin error (EPIPE) without crashing", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
    });
    // Simulate the child exiting before reading all of stdin.
    fake.emitStdinError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await assert.rejects(promise, /EPIPE/);
});
test("runAdvisor rejects when output exceeds maxOutputBytes and kills the child", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
        maxOutputBytes: 16,
    });
    fake.emitStdout("x".repeat(32));
    await assert.rejects(promise, /output exceeded 16 bytes/);
    assert.ok(fake.killSignals.includes("SIGKILL"), "expected SIGKILL after exceeding output budget");
});
test("runAdvisor rejects when exit is 0 but no stdout was produced", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
    });
    fake.close(0);
    await assert.rejects(promise, /exited 0 with no output/);
});
test("runAdvisor sends SIGTERM immediately on timeout", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    await assert.rejects(runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
        timeoutMs: 20,
    }), /timed out after 20ms/);
    assert.ok(fake.killSignals.includes("SIGTERM"), "expected SIGTERM after timeout");
});
test("runAdvisor ignores late close events after settling once (idempotent)", async () => {
    const fake = makeFakeChild();
    const spawner = () => fake.child;
    const promise = runAdvisor({
        model: "opus",
        prompt: "p",
        spawner,
    });
    fake.emitStdout("first");
    fake.close(0);
    // A second close (e.g. racing with a timeout) must not double-resolve.
    fake.close(1);
    const result = await promise;
    assert.equal(result, "first");
});
