import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { parseOutcome, resolveOptions } from "./core.js";
import { ReviewMonitor } from "./monitor.js";

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal: AbortSignal;
    input?: string;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure = error as Error;
      }
    };
    const timer = setTimeout(() => {
      failure = new Error("CLI timed out");
      kill();
    }, options.timeoutMs);
    const abort = () => {
      failure = new Error("cancelled");
      kill();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 64 * 1024 * 1024) {
        failure = new Error("CLI output exceeded 64 MiB");
        kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        failure = error;
        kill();
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}
function readLedger(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const size = fstatSync(fd).size,
      start = Math.max(0, size - 8 * 1024 * 1024),
      buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}
export default {
  id: "jev-gate",
  async setup(ctx) {
    const directory = ctx.location.directory,
      options = resolveOptions(ctx.options, { directory });
    const args = ["snapshot", "--json"];
    for (const [flag, value] of [
      ["base", options.base],
      ["config", options.config],
      ["policy-source", options.policySource],
      ["provider", options.provider],
      ["model", options.model],
    ])
      if (value) args.push(`--${flag}`, value);
    const monitor = new ReviewMonitor({
      read: () => readLedger(options.ledgerPath),
      append: (record) => {
        mkdirSync(dirname(options.ledgerPath), { recursive: true });
        appendFileSync(options.ledgerPath, JSON.stringify(record) + "\n", {
          mode: 0o600,
        });
      },
      collect: async (signal) => {
        const result = await runProcess(
          options.cli,
          [...options.cliArgs, ...args],
          {
            cwd: directory,
            env: process.env,
            timeoutMs: options.timeoutMs,
            signal,
          },
        );
        if (result.code !== 0)
          throw new Error(`snapshot command failed (${result.code})`);
        const snapshot = JSON.parse(result.stdout) as {
          schema?: number;
          id?: string;
          config?: { provider?: string };
        };
        if (
          snapshot.schema !== 1 ||
          typeof snapshot.id !== "string" ||
          !/^[a-f0-9]{64}$/.test(snapshot.id) ||
          !["typesafe", "openrouter"].includes(snapshot.config?.provider ?? "")
        )
          throw new Error("CLI returned an invalid snapshot");
        return {
          id: snapshot.id,
          text: result.stdout,
          provider: snapshot.config!.provider as "typesafe" | "openrouter",
        };
      },
      review: async (snapshot, signal) => {
        const env = { ...process.env };
        if (options.apiKey)
          env[
            snapshot.provider === "openrouter"
              ? "OPENROUTER_API_KEY"
              : "TYPESAFE_API_KEY"
          ] = options.apiKey;
        const result = await runProcess(
          options.cli,
          [
            ...options.cliArgs,
            "review",
            "--snapshot",
            "-",
            "--json",
            "--no-gate",
          ],
          {
            cwd: directory,
            env,
            timeoutMs: options.timeoutMs,
            signal,
            input: snapshot.text,
          },
        );
        const outcome = parseOutcome(result.stdout);
        if (!outcome)
          throw new Error(
            `CLI review unavailable (${result.code}); inspect CLI configuration`,
          );
        return outcome;
      },
    });
    const log = (e: unknown) =>
      console.error(`[jev-gate] ${e instanceof Error ? e.message : String(e)}`);
    await ctx.session.hook("context", async (event) => {
      try {
        if (options.inject)
          await monitor.deliver(String(event.sessionID), (text) =>
            event.system.push({ type: "text", text }),
          );
        else await monitor.poll();
      } catch (e) {
        log(e);
        if (options.inject)
          event.system.push({
            type: "text",
            text: "JEV review is unavailable. Do not treat this change as reviewed; inspect the plugin log and CLI configuration.",
          });
      }
    });
    const timer = setInterval(() => {
      void monitor.poll().catch(log);
    }, options.intervalMs);
    void monitor.poll().catch(log);
    return async () => {
      clearInterval(timer);
      await monitor.dispose();
    };
  },
} satisfies Plugin.Plugin;
