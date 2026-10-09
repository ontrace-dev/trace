import { join } from "node:path";
import { env } from "../../env.ts";

/**
 * Local, multilingual sentence embeddings (transformers.js + ONNX runtime). No API key, no data
 * leaves the machine. The model (~120 MB) is downloaded on first use into DATA_DIR/models.
 * A German question finds an English article — that's the point.
 */

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let loading: Promise<Extractor | null> | null = null;
let state: { status: "off" | "loading" | "ready" | "error"; error?: string } = {
  status: env.EMBEDDINGS === "off" ? "off" : "loading",
};

async function load(): Promise<Extractor | null> {
  if (env.EMBEDDINGS === "off") return null;
  try {
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = join(env.DATA_DIR, "models");
    const extractor = (await t.pipeline("feature-extraction", env.EMBEDDINGS_MODEL, {
      dtype: "q8",
    })) as unknown as Extractor;
    state = { status: "ready" };
    console.log(`[embeddings] ${env.EMBEDDINGS_MODEL} ready`);
    return extractor;
  } catch (err) {
    state = { status: "error", error: err instanceof Error ? err.message : String(err) };
    console.warn("[embeddings] unavailable, falling back to keyword search:", state.error);
    scheduleRetry();
    return null;
  }
}

// A first download can fail transiently (network, a fresh volume). Retry in the background with backoff;
// search uses keywords meanwhile, and once the model is there, chunks indexed without vectors get them.
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
let attempt = 0;
function scheduleRetry() {
  if (attempt >= RETRY_MS.length) return;
  const wait = RETRY_MS[attempt++]!;
  setTimeout(() => {
    loading = load().then(async (fe) => {
      if (fe) {
        const { backfillIndex, enqueueIndexing } = await import("./indexer.ts");
        void enqueueIndexing(backfillIndex);
      }
      return fe;
    });
  }, wait).unref();
}

function extractor() {
  loading ??= load();
  return loading;
}

/** Warm the model in the background so the first search isn't slow. */
export function warmEmbeddings() {
  void extractor();
}

export function embeddingStatus() {
  return { ...state, model: env.EMBEDDINGS_MODEL };
}

// The ONNX session is not re-entrant friendly under heavy concurrency; serialize calls.
let chain: Promise<unknown> = Promise.resolve();

/** Embed texts (normalized, 384 dims). Returns null when embeddings are disabled or failed to load. */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  const fe = await extractor();
  if (!fe) return null;
  const run = chain.then(async () => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 2000));
      out.push(...(await fe(batch, { pooling: "mean", normalize: true })).tolist());
    }
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

export async function embedOne(text: string) {
  const r = await embed([text]);
  return r?.[0] ?? null;
}
