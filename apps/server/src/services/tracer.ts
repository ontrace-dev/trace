import { db } from "../db/index.ts";
import { spans } from "../db/schema.ts";
import { id } from "../lib/ids.ts";
import type { SimulationSpan } from "../lib/types.ts";

type SpanKind = "ai" | "tool" | "integration" | "system";

export interface SpanHandle {
  id: string;
  /** Record a result summary + attributes and persist the span. */
  end(opts?: { summary?: string; attributes?: Record<string, unknown>; status?: "ok" | "error" }): Promise<void>;
}

/**
 * A trace is the receipt for one unit of work on a ticket (e.g. "AI handled inbound message").
 * Each step is a span; together they render as the waterfall in the ticket's trace view.
 */
export class Trace {
  readonly id = id("trc");
  /** Spans of in-memory traces (simulations), in start order. */
  readonly collected: SimulationSpan[] = [];
  constructor(
    readonly orgId: string,
    readonly ticketId: string | null,
    /** false: keep spans in memory only (simulations and tests write nothing). */
    readonly persist = true,
  ) {}

  start(name: string, kind: SpanKind = "system", parentId?: string): SpanHandle {
    const spanId = id("spn");
    const startedAt = new Date();
    const t0 = performance.now();
    return {
      id: spanId,
      end: async (opts = {}) => {
        if (!this.persist) {
          this.collected.push({
            name,
            kind,
            status: opts.status ?? "ok",
            summary: opts.summary ?? null,
            attributes: opts.attributes ?? {},
            startedAt: startedAt.toISOString(),
            durationMs: Math.round(performance.now() - t0),
          });
          return;
        }
        await db.insert(spans).values({
          id: spanId,
          orgId: this.orgId,
          ticketId: this.ticketId,
          traceId: this.id,
          parentId: parentId ?? null,
          name,
          kind,
          status: opts.status ?? "ok",
          summary: opts.summary ?? null,
          attributes: opts.attributes ?? {},
          startedAt,
          durationMs: Math.round(performance.now() - t0),
        });
      },
    };
  }

  /** Run fn inside a span; errors mark the span as failed and are re-thrown. */
  async span<T>(
    name: string,
    kind: SpanKind,
    fn: (span: SpanHandle) => Promise<T>,
    describe?: (result: T) => { summary?: string; attributes?: Record<string, unknown> },
  ): Promise<T> {
    const s = this.start(name, kind);
    try {
      const result = await fn(s);
      await s.end(describe?.(result));
      return result;
    } catch (err) {
      await s.end({ status: "error", summary: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Record an instantaneous event span. */
  async event(name: string, kind: SpanKind, summary: string, attributes: Record<string, unknown> = {}) {
    await this.start(name, kind).end({ summary, attributes });
  }
}
