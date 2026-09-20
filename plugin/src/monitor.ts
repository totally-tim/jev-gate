import { formatBriefing, parseOutcome, type OutcomeView } from "./core.js";
export interface SnapshotView {
  id: string;
  text: string;
  provider: "typesafe" | "openrouter";
}
export interface MonitorIO {
  collect(signal: AbortSignal): Promise<SnapshotView>;
  review(snapshot: SnapshotView, signal: AbortSignal): Promise<OutcomeView>;
  read(): string;
  append(record: unknown): void;
  now?: () => number;
  backoffMs?: number;
}
/** Owns assessment freshness, retry state, and per-session delivery. No host policy lives here. */
export class ReviewMonitor {
  private controller = new AbortController();
  private latest: OutcomeView | null = null;
  private delivered = new Map<string, Set<string>>();
  private retryAt = 0;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private io: MonitorIO) {
    for (const line of io.read().split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line) as {
          type?: string;
          outcome?: unknown;
          session?: string;
          keys?: string[];
        };
        if (record.type === "assessment") {
          const o = parseOutcome(JSON.stringify(record.outcome));
          if (o) {
            this.latest = o;
            this.retryAt =
              o.health === "complete"
                ? 0
                : (this.io.now ?? Date.now)() + (this.io.backoffMs ?? 300000);
          }
        }
        if (
          record.type === "delivery" &&
          typeof record.session === "string" &&
          Array.isArray(record.keys) &&
          record.keys.every((k) => typeof k === "string")
        ) {
          const set = this.delivered.get(record.session) ?? new Set<string>();
          for (const k of record.keys) set.add(k);
          this.delivered.set(record.session, set);
        }
      } catch {
        /* A partial final append cannot become an assessment or delivery. */
      }
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn, fn);
    this.serial = task.catch(() => {});
    return task;
  }
  private async assess(): Promise<void> {
    if (this.controller.signal.aborted) return;
    const snapshot = await this.io.collect(this.controller.signal);
    if (this.controller.signal.aborted) return;
    if (
      this.latest?.snapshotId === snapshot.id &&
      (this.latest.health === "complete" ||
        (this.io.now ?? Date.now)() < this.retryAt)
    )
      return;
    this.latest = null;
    let outcome: OutcomeView;
    try {
      outcome = await this.io.review(snapshot, this.controller.signal);
      if (outcome.snapshotId !== snapshot.id)
        throw new Error("review returned a different snapshot");
    } catch (error) {
      outcome = {
        schema: 2,
        snapshotId: snapshot.id,
        health: "unavailable",
        status: "unavailable",
        policyHash: "0".repeat(64),
        model: "unavailable",
        findings: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (this.controller.signal.aborted) return;
    const current = await this.io.collect(this.controller.signal);
    if (this.controller.signal.aborted || current.id !== snapshot.id) return;
    // Persist before acknowledging completion, so restart can restore undelivered findings.
    this.io.append({
      type: "assessment",
      at: new Date().toISOString(),
      outcome,
    });
    this.latest = outcome;
    this.retryAt =
      outcome.health === "complete"
        ? 0
        : (this.io.now ?? Date.now)() + (this.io.backoffMs ?? 300000);
  }
  poll(): Promise<void> {
    return this.exclusive(() => this.assess());
  }
  deliver(session: string, inject: (text: string) => void): Promise<void> {
    return this.exclusive(async () => {
      await this.assess();
      if (this.controller.signal.aborted || !this.latest) return;
      const current = await this.io.collect(this.controller.signal);
      if (
        this.controller.signal.aborted ||
        current.id !== this.latest.snapshotId
      ) {
        this.latest = null;
        return;
      }
      const seen = this.delivered.get(session) ?? new Set<string>();
      const findings = this.latest.findings.filter(
        (f) => f.status === "open" && !seen.has(f.id),
      );
      const healthKey = `health:${this.latest.snapshotId}:${this.latest.health}`;
      const reportHealth =
        this.latest.health !== "complete" && !seen.has(healthKey);
      if (!findings.length && !reportHealth) return;
      const text = formatBriefing(this.latest, findings);
      if (!text) return;
      inject(text);
      const keys = [
        ...findings.slice(0, 10).map((f) => f.id),
        ...(reportHealth ? [healthKey] : []),
      ];
      // The hook accepted the briefing. A failed append may cause a repeat, never a silent loss.
      this.io.append({
        type: "delivery",
        at: new Date().toISOString(),
        session,
        snapshotId: this.latest.snapshotId,
        keys,
      });
      for (const key of keys) seen.add(key);
      this.delivered.set(session, seen);
    });
  }
  async dispose(): Promise<void> {
    this.controller.abort();
    await this.serial.catch(() => {});
  }
}
