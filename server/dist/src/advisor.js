import { spawn } from "node:child_process";
/**
 * Invokes `claude -p --model <model>` as a subprocess, writes the prompt to
 * stdin, and resolves with the trimmed stdout. Rejects on non-zero exit or
 * timeout. No shell is used — args are passed as an array and the prompt is
 * streamed over stdin, so there are no escaping or argv length concerns.
 */
export function runAdvisor(opts) {
    const { model, prompt, spawner = spawn, timeoutMs = 120_000 } = opts;
    return new Promise((resolve, reject) => {
        const child = spawner("claude", ["-p", "--model", model], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            settle(() => {
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    // ignore
                }
                reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
            });
        }, timeoutMs);
        child.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("error", (err) => {
            settle(() => reject(err));
        });
        child.on("close", (code) => {
            settle(() => {
                if (code === 0) {
                    resolve(stdout.trim());
                }
                else {
                    const msg = stderr.trim() || stdout.trim() || "(no output)";
                    reject(new Error(`claude -p exited ${code}: ${msg}`));
                }
            });
        });
        if (child.stdin) {
            child.stdin.end(prompt);
        }
        else {
            settle(() => reject(new Error("spawned process has no stdin")));
        }
    });
}
