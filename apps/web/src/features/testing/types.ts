import type { Source, TicketChannel } from "@/lib/types";

export interface SimulatedActionCall {
  name: string;
  input: Record<string, unknown>;
  mode: "executed" | "simulated" | "approval";
  output?: string;
}

export interface SimulationSpan {
  name: string;
  kind: "ai" | "tool" | "integration" | "system";
  status: "ok" | "error";
  summary: string | null;
  attributes: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
}

export interface SimulationResult {
  outcome: "reply" | "escalate";
  body: string;
  confidence: number;
  sources: Source[];
  reason?: string;
  internalNote?: string;
  triage?: {
    priority?: string;
    tags?: string[];
    intent?: string;
    language?: string;
    sentiment?: string;
    summary?: string;
  };
  policy: { autoSend: boolean; why: string };
  actions: SimulatedActionCall[];
  spans: SimulationSpan[];
  provider: "claude" | "local";
  durationMs: number;
}

export interface TestResult {
  ranAt: string;
  passed: boolean;
  score: number;
  verdict: string;
  outcomeMatched: boolean;
  simulation: SimulationResult;
}

export type ExpectedOutcome = "reply" | "escalate" | "any";

export interface TestCase {
  id: string;
  name: string;
  subject: string;
  message: string;
  channel: TicketChannel;
  customerEmail: string | null;
  expectation: string;
  expectedOutcome: ExpectedOutcome;
  sourceTicketId: string | null;
  lastResult: TestResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestRun {
  id: string;
  status: "running" | "done" | "failed";
  total: number;
  completed: number;
  passed: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface SimulationInput {
  message: string;
  subject?: string;
  channel?: TicketChannel;
  customerEmail?: string;
  history?: { from: "customer" | "agent"; body: string }[];
  aiOverrides?: {
    mode?: "draft" | "auto";
    autoSendThreshold?: number;
    tone?: "friendly" | "formal" | "concise";
    guidance?: string;
  };
}
