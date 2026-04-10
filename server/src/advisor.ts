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
}

/**
 * Invokes `claude -p --model <model>` as a subprocess, writes the prompt to
 * stdin, and resolves with the trimmed stdout. Rejects on non-zero exit or
 * timeout. No shell is used — args are passed as an array and the prompt is
 * streamed over stdin, so there are no escaping or argv length concerns.
 */
export function runAdvisor(opts: RunAdvisorOptions): Promise<string> {
  const { model, prompt, spawner = spawn, timeoutMs = 120_000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawner("claude", ["-p", "--model", model], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const msg = stderr.trim() || stdout.trim() || "(no output)";
          reject(new Error(`claude -p exited ${code}: ${msg}`));
        }
      });
    });

    if (child.stdin) {
      child.stdin.end(prompt);
    } else {
      settle(() => reject(new Error("spawned process has no stdin")));
    }
  });
}
