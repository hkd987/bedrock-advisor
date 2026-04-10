import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { runAdvisor, type Spawner } from "../src/advisor.js";

/**
 * Builds a fake ChildProcess that records stdin writes and lets the test
 * drive stdout/stderr/close events deterministically.
 */
function makeFakeChild(): {
  child: ChildProcess;
  stdinChunks: string[];
  emitStdout: (text: string) => void;
  emitStderr: (text: string) => void;
  close: (code: number) => void;
  error: (err: Error) => void;
} {
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinChunks: string[] = [];

  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });

  (emitter as unknown as { stdout: EventEmitter }).stdout = stdout;
  (emitter as unknown as { stderr: EventEmitter }).stderr = stderr;
  (emitter as unknown as { stdin: Writable }).stdin = stdin;
  (emitter as unknown as { kill: () => void }).kill = () => {};

  return {
    child: emitter as unknown as ChildProcess,
    stdinChunks,
    emitStdout: (t) => stdout.emit("data", Buffer.from(t)),
    emitStderr: (t) => stderr.emit("data", Buffer.from(t)),
    close: (code) => emitter.emit("close", code),
    error: (err) => emitter.emit("error", err),
  };
}

test("runAdvisor spawns claude with -p --model <model> and pipes the prompt via stdin", async () => {
  const fake = makeFakeChild();
  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];

  const spawner: Spawner = (command, args) => {
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
  const spawner: Spawner = () => fake.child;

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
  const spawner: Spawner = () => fake.child;

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
  const spawner: Spawner = () => fake.child;

  await assert.rejects(
    runAdvisor({
      model: "opus",
      prompt: "p",
      spawner,
      timeoutMs: 20,
    }),
    /timed out after 20ms/,
  );
});

test("runAdvisor passes a custom model through to argv", async () => {
  const fake = makeFakeChild();
  let capturedArgs: readonly string[] = [];
  const spawner: Spawner = (_c, args) => {
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
