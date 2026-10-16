/**
 * Portal styles live in the element's shadow root, so the host page can't break them by accident.
 * Theming hooks for the host page (they pierce the shadow root on purpose):
 *   - CSS variables on the element:  trace-portal { --trace-accent: #0f766e; --trace-font: Inter; }
 *   - parts:                         trace-portal::part(ticket-row) { border-radius: 0; }
 */
export const css = /* css */ `
:host { display: block; }
:host([hidden]) { display: none; }
.root {
  --accent: var(--trace-accent, var(--_accent, #b9a3ff));
  --accent-fg: var(--trace-accent-foreground, var(--_accent-fg, #0a0a0a));
  --r: var(--trace-radius, var(--_r, 12px));
  --font: var(--trace-font, var(--_font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif));
  --max: var(--trace-max-width, 880px);
  --bg: var(--trace-background, #f6f6f7);
  --surface: var(--trace-surface, #ffffff);
  --surface-2: var(--trace-surface-2, #f2f2f4);
  --fg: var(--trace-foreground, #18181b);
  --fg-2: #3f3f46;
  --muted: var(--trace-muted, #71717a);
  --line: var(--trace-border, rgba(0,0,0,.09));
  --line-2: rgba(0,0,0,.16);
  --ok: #15803d; --ok-bg: #dcfce7;
  --warn: #b45309; --warn-bg: #fef3c7;
  --info: #1d4ed8; --info-bg: #dbeafe;
  --danger: #dc2626;
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
.root[data-theme="dark"] {
  --bg: var(--trace-background, #0e0e10);
  --surface: var(--trace-surface, #151518);
  --surface-2: var(--trace-surface-2, #1d1d21);
  --fg: var(--trace-foreground, #f4f4f5);
  --fg-2: #d4d4d8;
  --muted: var(--trace-muted, #9a9aa6);
  --line: var(--trace-border, rgba(255,255,255,.09));
  --line-2: rgba(255,255,255,.18);
  --ok: #4ade80; --ok-bg: rgba(74,222,128,.12);
  --warn: #fbbf24; --warn-bg: rgba(251,191,36,.13);
  --info: #93c5fd; --info-bg: rgba(147,197,253,.13);
  --danger: #f87171;
}
/* Embedded in someone else's page: no backdrop of our own unless they set one. */
.root.embed { --bg: var(--trace-background, transparent); }
.root.page { min-height: 100vh; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
input, textarea { font: inherit; color: inherit; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ----------------------------------------------------------- header */
.top { background: var(--surface); border-bottom: 1px solid var(--line); }
.embed .top { background: transparent; border-bottom: 0; }
.top .in { max-width: var(--max); margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 12px; }
.embed .top .in { padding: 0 0 14px; max-width: none; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; text-decoration: none; }
.brand img { height: 28px; width: auto; max-width: 140px; object-fit: contain; border-radius: calc(var(--r) * .35); }
.brand .mark { width: 28px; height: 28px; border-radius: calc(var(--r) * .5); background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.brand b { font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -.01em; }
.spacer { flex: 1; }
.homelink { font-size: 13px; color: var(--muted); text-decoration: none; white-space: nowrap; }
.homelink:hover { color: var(--fg); }
.me { position: relative; }
.me > button { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 4px; border-radius: 999px; }
.me > button:hover { background: var(--surface-2); }
.me .av { width: 28px; height: 28px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--fg-2); }
.me .nm { font-size: 13px; max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.menu { position: absolute; right: 0; top: calc(100% + 6px); min-width: 220px; z-index: 5; background: var(--surface); border: 1px solid var(--line); border-radius: calc(var(--r) * .8); box-shadow: 0 12px 32px -12px rgba(0,0,0,.25); padding: 6px; }
.menu .who { padding: 8px 10px; font-size: 12.5px; color: var(--muted); border-bottom: 1px solid var(--line); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; }
.menu button { width: 100%; text-align: left; padding: 8px 10px; border-radius: calc(var(--r) * .5); font-size: 13px; }
.menu button:hover { background: var(--surface-2); }

/* ----------------------------------------------------------- layout */
main { max-width: var(--max); margin: 0 auto; padding: 28px 20px 48px; }
.embed main { padding: 0; max-width: none; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; font-weight: 700; }
.intro { margin: 6px 0 0; color: var(--muted); max-width: 560px; }
.back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
.back:hover { color: var(--fg); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }

/* ----------------------------------------------------------- controls */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 38px; padding: 0 16px; border-radius: calc(var(--r) * .7); font-weight: 600; font-size: 13.5px; border: 1px solid var(--line-2); background: var(--surface); white-space: nowrap; transition: transform .12s, opacity .12s, background .12s; }
.btn:hover { background: var(--surface-2); }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn.primary:hover { filter: brightness(.97); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.sm { height: 32px; padding: 0 12px; font-size: 13px; }
.input, .textarea { width: 100%; border: 1px solid var(--line-2); background: var(--surface); border-radius: calc(var(--r) * .6); padding: 10px 12px; outline: none; font-size: 14px; }
.input:focus, .textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.input::placeholder, .textarea::placeholder { color: var(--muted); }
.textarea { resize: vertical; min-height: 120px; line-height: 1.5; }
label.f { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--fg-2); }
label.f span.h { font-weight: 400; color: var(--muted); font-size: 12.5px; }
.err { color: var(--danger); font-size: 13px; }

/* ----------------------------------------------------------- search */
.search { position: relative; margin-bottom: 20px; }
.search .input { padding-left: 38px; height: 44px; }
.search svg { position: absolute; left: 13px; top: 13px; color: var(--muted); }
.answers { margin-top: 8px; display: flex; flex-direction: column; }
.answers .hd { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; padding: 10px 14px 4px; }
.answer { display: block; width: 100%; text-align: left; padding: 10px 14px; border-top: 1px solid var(--line); text-decoration: none; }
.answer:first-of-type { border-top: 0; }
.answer:hover { background: var(--surface-2); }
.answer b { display: block; font-size: 14px; font-weight: 600; }
.answer span { display: block; font-size: 13px; color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.article { padding: 18px 20px; }
.article h2 { margin: 0 0 8px; font-size: 18px; }

/* ----------------------------------------------------------- list */
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 0; overflow-x: auto; }
.tab { padding: 10px 12px; font-size: 13.5px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; }
.tab:hover { color: var(--fg); }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.tab .n { font-size: 11.5px; padding: 0 6px; border-radius: 99px; background: var(--surface-2); color: var(--muted); font-weight: 600; line-height: 18px; }
.tab .n.hot { background: var(--warn-bg); color: var(--warn); }
.list { margin-top: 14px; overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; width: 100%; text-align: left; padding: 14px 18px; border-top: 1px solid var(--line); text-decoration: none; color: inherit; }
.row:first-child { border-top: 0; }
.row:hover { background: var(--surface-2); }
.row .s { font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .m { grid-column: 1; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .r { grid-row: 1 / span 2; grid-column: 2; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 4px; }
.row .t { font-size: 12px; color: var(--muted); white-space: nowrap; }
.row.you .s::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--warn); margin-right: 8px; vertical-align: 1px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 99px; white-space: nowrap; }
.pill.open { background: var(--info-bg); color: var(--info); }
.pill.awaiting_you { background: var(--warn-bg); color: var(--warn); }
.pill.solved { background: var(--ok-bg); color: var(--ok); }
.empty { padding: 44px 20px; text-align: center; color: var(--muted); }
.empty b { display: block; color: var(--fg); font-size: 15px; margin-bottom: 4px; }
.empty .btn { margin-top: 14px; }
.more { text-align: center; padding: 12px; font-size: 13px; color: var(--muted); }

/* ----------------------------------------------------------- ticket */
.thead { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 6px; flex-wrap: wrap; }
.meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 20px; }
.meta .dotsep::before { content: "·"; margin-right: 12px; }
.banner { padding: 12px 16px; margin-bottom: 18px; display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap; font-size: 13.5px; background: color-mix(in srgb, var(--accent) 9%, var(--surface)); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }
.thread { display: flex; flex-direction: column; gap: 12px; }
.msg { padding: 14px 18px; }
.msg.you { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); border-color: color-mix(in srgb, var(--accent) 24%, var(--line)); }
.msg.pending { opacity: .6; }
.msg .h { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.msg .av { width: 30px; height: 30px; border-radius: 99px; display: grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--surface-2); color: var(--fg-2); flex-shrink: 0; overflow: hidden; }
.msg .av img { width: 100%; height: 100%; object-fit: cover; }
.msg.ai .av, .msg.you .av { background: var(--accent); color: var(--accent-fg); }
.msg .h b { font-size: 13.5px; font-weight: 600; }
.msg .h span { font-size: 12px; color: var(--muted); }
.msg .h .tag { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; background: var(--surface-2); color: var(--muted); }
.body { overflow-wrap: anywhere; }
.body p { margin: 0 0 8px; } .body p:last-child { margin-bottom: 0; }
.body ul, .body ol { margin: 4px 0 8px; padding-left: 20px; }
.body code { font-family: ui-monospace, Menlo, monospace; font-size: .88em; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.body a { color: color-mix(in srgb, var(--accent) 60%, var(--fg)); text-underline-offset: 2px; }
.files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.file { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 5px 10px; border: 1px solid var(--line-2); border-radius: 99px; }
.file:hover { background: var(--surface-2); }
.working { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 4px 4px; }
.working i { width: 6px; height: 6px; border-radius: 99px; background: var(--muted); animation: blink 1.2s infinite ease-in-out; }
.working i:nth-child(2) { animation-delay: .15s; } .working i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
.composer { margin-top: 16px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.composer .textarea { min-height: 96px; border: 0; padding: 4px 4px; box-shadow: none; background: transparent; }
.composer .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.composer .note { font-size: 12.5px; color: var(--muted); }
.solved-note { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 12px 16px; font-size: 13.5px; color: var(--ok); background: var(--ok-bg); border-radius: var(--r); }

/* ----------------------------------------------------------- forms */
.form { padding: 22px; display: flex; flex-direction: column; gap: 16px; }
.form .actions { display: flex; justify-content: flex-end; gap: 8px; }
.suggest { padding: 0; overflow: hidden; }

/* ----------------------------------------------------------- sign-in */
.signin { max-width: 420px; margin: 6vh auto 0; padding: 30px 28px; text-align: center; }
.embed .signin { margin-top: 12px; }
.signin .mark { width: 44px; height: 44px; border-radius: calc(var(--r) * .8); margin: 0 auto 14px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-weight: 700; overflow: hidden; }
.signin .mark img { width: 100%; height: 100%; object-fit: contain; background: var(--surface); }
.signin h1 { font-size: 22px; }
.signin p { color: var(--muted); margin: 8px 0 20px; }
.signin form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
.signin .btn { width: 100%; height: 42px; }
.signin .or { display: flex; align-items: center; gap: 10px; margin: 16px 0; color: var(--muted); font-size: 12px; }
.signin .or::before, .signin .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.sent { display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 99px; background: var(--ok-bg); color: var(--ok); }

.foot { text-align: center; font-size: 12px; color: var(--muted); padding: 24px 0 8px; }
.foot a { text-decoration: none; font-weight: 600; }
.foot a:hover { text-decoration: underline; }
.loading { display: grid; place-items: center; padding: 64px 0; color: var(--muted); }
.spin { width: 20px; height: 20px; border: 2px solid var(--line-2); border-top-color: var(--accent); border-radius: 99px; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 600px) {
  main { padding: 20px 16px 40px; }
  .top .in { padding: 12px 16px; }
  .me .nm, .homelink { display: none; }
  h1 { font-size: 22px; }
  .row { grid-template-columns: minmax(0, 1fr); padding: 12px 14px; }
  .row .r { grid-row: auto; grid-column: 1; flex-direction: row; justify-content: flex-start; align-items: center; gap: 8px; }
  .hero .btn { width: 100%; }
  .signin { padding: 24px 18px; }
}
@media (prefers-reduced-motion: reduce) { .spin, .working i { animation: none; } }
`;
