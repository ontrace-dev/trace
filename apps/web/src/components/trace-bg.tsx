/**
 * Decorative background for the auth screens: fields of trace spans writing
 * themselves left to right, in the same visual language as the real waterfall
 * (hairline grid, mono labels, white spans, the odd accent one for model calls).
 * Purely ornamental — hidden from assistive tech and from reduced-motion users'
 * animation, which falls back to a static field.
 */

type Tone = "line" | "accent" | "ok";
type Bar = { top: number; left: number; width: number; delay: number; dur: number; tone: Tone };
type Label = { top: number; left: number; text: string };

/** Deterministic PRNG so the field is identical on every render and reload. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const TRACE_IDS = ["8f21c40a", "b3d7e119", "4f2a9b71", "c05e62df", "7ad14e83"];

const { bars, labels } = (() => {
  const next = rng(20260407);
  const bars: Bar[] = [];
  const labels: Label[] = [];
  const groups = 4;
  const perGroup = 8;

  for (let g = 0; g < groups; g++) {
    const top = 11 + g * 22.5 + next() * 2;
    const delay = g * 2.4 + next();
    let left = 2 + next() * 8;
    labels.push({ top: top - 2.4, left, text: `trace/${TRACE_IDS[g]!}` });

    for (let i = 0; i < perGroup; i++) {
      const width = 4 + next() * (i === perGroup - 1 ? 22 : 13);
      // The last span of a trace is the long "close" one, like the real view.
      bars.push({
        top: top + i * 2.2,
        left,
        width: Math.min(width, 94 - left),
        delay: delay + i * 0.42,
        dur: 15 + g * 1.5,
        tone: i === 2 || i === perGroup - 3 ? "accent" : i === 5 ? "ok" : "line",
      });
      left = Math.min(left + width * 0.72 + next() * 5, 78);
    }
  }
  return { bars, labels };
})();

const TONE: Record<Tone, string> = {
  line: "bg-white/[0.26]",
  accent: "bg-accent/70",
  ok: "bg-ok/45",
};

export function TraceBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      <div className="trace-field absolute inset-0">
        {/* time axis, same ticks as the waterfall header */}
        {[25, 50, 75].map((x) => (
          <span key={x} className="absolute inset-y-0 w-px bg-white/[0.06]" style={{ left: `${x}%` }} />
        ))}
        {labels.map((l) => (
          <span
            key={l.text}
            className="absolute font-mono text-[10px] tracking-[0.08em] whitespace-nowrap text-white/[0.3]"
            style={{ top: `${l.top}%`, left: `${l.left}%` }}
          >
            {l.text}
          </span>
        ))}
        {bars.map((b, i) => (
          <span
            key={i}
            className={`trace-bar absolute h-[4px] origin-left ${TONE[b.tone]}`}
            style={{
              top: `${b.top}%`,
              left: `${b.left}%`,
              width: `${b.width}%`,
              animationDuration: `${b.dur}s`,
              animationDelay: `-${b.delay}s`,
            }}
          />
        ))}
      </div>
      {/* a slow playhead sweeping the whole field, left to right */}
      <span className="trace-sweep absolute inset-y-0 -left-72 w-72 bg-gradient-to-r from-transparent via-accent/[0.09] to-transparent" />
    </div>
  );
}
