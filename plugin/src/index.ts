import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Plugin } from "@opencode/plugin";
import {
  deliveryLine,
  formatBriefing,
  hashDiff,
  lastLedgerHash,
  ledgerLine,
  parseOutcome,
  resolveOptions,
} from "./core.js";

/** A child process that always resolves, with its exit code and captured output. */
interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/**
 * Watch the local change set and review it when it moves.
 *
 * Ledger mode is the default: every new diff gets one review, recorded in
 * `.jev-gate/ledger.jsonl`, and nothing is injected. With `inject: true` the gated findings
 * are also queued and handed to the next model call as a system block, once per diff.
 */
export default Plugin.define({
  id: "jev-gate",
  async setup(ctx) {
    const directory = typeof ctx.location?.directory === "string" ? ctx.location.directory : process.cwd();
    const options = resolveOptions(ctx.options, { directory });
    const log = (message: string): void => console.log(`[jev-gate] ${message}`);

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (options.apiKey !== undefined) {
      childEnv[options.provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"] = options.apiKey;
    }

    const diffArgs = ["diff", ...(options.base === undefined ? [] : ["--base", options.base])];
    const reviewArgs = ["review", "--diff", "-", "--json", "--no-gate"];
    if (options.provider !== undefined) reviewArgs.push("--provider", options.provider);
    if (options.model !== undefined) reviewArgs.push("--model", options.model);

    let pending: { hash: string; text: string } | null = null;
    // A new session inherits the last reviewed hash from the ledger, so an unchanged diff
    // is not reviewed (and paid for) again just because the session restarted.
    let lastHash: string | null = (() => {
      try {
        return lastLedgerHash(readFileSync(options.ledgerPath, "utf8"));
      } catch {
        return null;
      }
    })();
    let failedHash: string | null = null;
    let failedUntil = 0;
    let running = false;
    let disposed = false;

    const FAILURE_BACKOFF_MS = 5 * 60_000;

    const writeLedger = (line: string): void => {
      mkdirSync(dirname(options.ledgerPath), { recursive: true });
      appendFileSync(options.ledgerPath, line);
    };

    const poll = async (): Promise<void> => {
      if (running || disposed) return;
      running = true;
      try {
        const diff = await runProcess(options.cli, [...options.cliArgs, ...diffArgs], {
          cwd: directory,
          env: childEnv,
          timeoutMs: options.timeoutMs,
        });
        if (diff.code !== 0) {
          log(`diff failed: ${firstLine(diff.stderr) || `exit ${diff.code}`}`);
          return;
        }
        if (diff.stdout.trim() === "") return;

        const hash = hashDiff(diff.stdout);
        if (hash === lastHash) return;
        if (hash === failedHash && Date.now() < failedUntil) return;

        const review = await runProcess(options.cli, [...options.cliArgs, ...reviewArgs], {
          cwd: directory,
          env: childEnv,
          timeoutMs: options.timeoutMs,
          input: diff.stdout,
        });
        if (review.code !== 0) {
          failedHash = hash;
          failedUntil = Date.now() + FAILURE_BACKOFF_MS;
          log(`review failed (exit ${review.code}): ${firstLine(review.stderr) || "no message"}`);
          return;
        }
        const outcome = parseOutcome(review.stdout);
        if (outcome === null) {
          failedHash = hash;
          failedUntil = Date.now() + FAILURE_BACKOFF_MS;
          log("review returned output the plugin could not read");
          return;
        }

        lastHash = hash;
        const briefing = options.inject ? formatBriefing(outcome, hash) : null;
        if (briefing !== null) pending = { hash, text: briefing };
        writeLedger(ledgerLine(outcome, hash, { injected: briefing !== null }));
        const summary =
          outcome.failedGates.length > 0 ? `gated: ${outcome.failedGates.join(", ")}` : "no gated findings";
        log(`diff ${hash}: ${summary}${briefing !== null ? "; briefing queued for the next model call" : ""}`);
      } catch (error) {
        log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
    };

    await ctx.session.hook("context", (event) => {
      if (!options.inject || pending === null) return;
      event.system.push({ type: "text", text: pending.text });
      writeLedger(
        deliveryLine(pending.hash, {
          agent: String(event.agent),
          messages: Array.isArray(event.messages) ? event.messages.length : -1,
        }),
      );
      log(`briefed the model on diff ${pending.hash}`);
      pending = null;
    });

    const timer = setInterval(() => {
      void poll();
    }, options.intervalMs);
    void poll();

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  },
});
