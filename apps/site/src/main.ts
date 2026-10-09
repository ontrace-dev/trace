const APP_URL = "https://app.ontrace.dev";
const REPO = "ontrace-dev/trace";

/** GitHub stars next to the topbar icon; the count stays hidden if the API is unreachable or rate-limited. */
async function loadStars() {
  const el = document.querySelector<HTMLElement>("[data-stars]");
  if (!el) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`);
    if (!res.ok) return;
    const { stargazers_count: n } = (await res.json()) as { stargazers_count: number };
    el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
    el.hidden = false;
  } catch {
    // Offline or blocked: the GitHub link works without the count.
  }
}

/** "resets in 14h 22m" from the demo instance; the static "resets daily" stays when it can't be read. */
async function loadDemoReset() {
  const els = document.querySelectorAll<HTMLElement>("[data-reset]");
  if (!els.length) return;
  try {
    const res = await fetch(`${APP_URL}/api/config`);
    if (!res.ok) return;
    const { demo } = (await res.json()) as { demo: { nextResetAt?: string } | null };
    const at = demo?.nextResetAt ? new Date(demo.nextResetAt).getTime() : NaN;
    if (Number.isNaN(at)) return;
    const render = () => {
      const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
      const text = `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
      for (const el of els) el.textContent = el.dataset.reset === "demo" ? `demo ${text}` : text;
    };
    render();
    setInterval(render, 30_000);
  } catch {
    // The app doesn't allow cross-origin reads of /api/config, or it's down.
  }
}

/** Copy buttons: `data-copy` holds the text to copy. */
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  button.addEventListener("click", async () => {
    const ok = await navigator.clipboard.writeText(button.dataset.copy ?? "").then(
      () => true,
      () => false,
    );
    if (!label) return;
    label.textContent = ok ? "copied" : "copy failed";
    setTimeout(() => (label.textContent = "copy"), 1500);
  });
}

void loadStars();
void loadDemoReset();
