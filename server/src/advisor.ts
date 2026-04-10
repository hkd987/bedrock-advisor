import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Minimal subset of `child_process.spawn` used by `runAdvisor`. Tests inject
 * a fake spawner that emits synthetic events — no real subprocess needed.
 */
export type Spawner = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface RunAdvisorOptions {
  /** Model alias or ID passed to `claude -p --model`. */
  model: string;
  /** Full prompt sent to Claude via stdin. */
  prompt: string;
  /** Injectable spawner for testing. Defaults to `child_process.spawn`. */
  spawner?: Spawner;
  /** Hard timeout in milliseconds. Defaults to 120000 (2 minutes). */
  timeoutMs?: number;
  /** Cap on stdout+stderr bytes buffered. Defaults to 1 MiB. */
  maxOutputBytes?: number;
}

/** Grace period between SIGTERM and SIGKILL when a timed-out child won't exit. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Invokes `claude -p --model <model>` as a subprocess, writes the prompt to
 * stdin, and resolves with the trimmed stdout. Rejects on non-zero exit,
 * timeout, stdin write error, or output exceeding `maxOutputBytes`. No shell
 * is used — args are passed as an array and the prompt is streamed over
 * stdin, so there are no escaping or argv length concerns.
 */
export function runAdvisor(opts: RunAdvisorOptions): Promise<string> {
  const {
    model,
    prompt,
    spawner = spawn,
    timeoutMs = 120_000,
    maxOutputBytes = 1 << 20,
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawner("claude", ["-p", "--model", model], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let settled = false;

    const forceKill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // Child may already be gone; ignore.
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        forceKill("SIGTERM");
        setTimeout(() => forceKill("SIGKILL"), SIGKILL_GRACE_MS).unref();
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    const capture = (chunks: Buffer[], d: Buffer) => {
      bufferedBytes += d.length;
      if (bufferedBytes > maxOutputBytes) {
        settle(() => {
          forceKill("SIGKILL");
          reject(
            new Error(
              `claude -p output exceeded ${maxOutputBytes} bytes — aborting`,
            ),
          );
        });
        return;
      }
      chunks.push(d);
    };

    child.stdout?.on("data", (d: Buffer) => capture(stdoutChunks, d));
    child.stderr?.on("data", (d: Buffer) => capture(stderrChunks, d));
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        const stdout = Buffer.concat(stdoutChunks).toString().trim();
        if (code === 0) {
          if (stdout.length === 0) {
            reject(new Error("claude -p exited 0 with no output"));
          } else {
            resolve(stdout);
          }
        } else {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          const msg = stderr || stdout || "(no output)";
          reject(new Error(`claude -p exited ${code}: ${msg}`));
        }
      });
    });

    if (!child.stdin) {
      settle(() => reject(new Error("spawned process has no stdin")));
      return;
    }
    // EPIPE is expected if the child exits before reading all of stdin; without
    // a listener Node crashes the whole process.
    child.stdin.on("error", (err) => settle(() => reject(err)));
    child.stdin.end(prompt);
  });
}
