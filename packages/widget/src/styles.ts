/** All widget styles live inside the shadow root, so host-page CSS can't leak in (or out). */
export const css = /* css */ `
:host { all: initial; }
.root {
  --r: 14px;
  --accent: #b9a3ff;
  --accent-fg: #0a0a0a;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --bg: #ffffff;
  --bg-2: #f6f6f7;
  --bg-3: #ececef;
  --fg: #18181b;
  --fg-2: #3f3f46;
  --muted: #71717a;
  --line: rgba(0,0,0,.08);
  --line-2: rgba(0,0,0,.14);
  --bubble-them: #f2f2f4;
  --shadow: 0 18px 50px -12px rgba(0,0,0,.28), 0 4px 14px -6px rgba(0,0,0,.14);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
.root[data-theme="dark"] {
  --bg: #111113;
  --bg-2: #18181b;
  --bg-3: #232327;
  --fg: #f4f4f5;
  --fg-2: #d4d4d8;
  --muted: #9a9aa6;
  --line: rgba(255,255,255,.08);
  --line-2: rgba(255,255,255,.16);
  --bubble-them: #1f1f23;
  --shadow: 0 18px 60px -10px rgba(0,0,0,.7), 0 4px 18px -6px rgba(0,0,0,.5);
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
input, textarea { font: inherit; color: inherit; }
a { color: inherit; }

/* ----------------------------------------------------------- launcher */
.launcher {
  position: fixed; z-index: 2147483000; bottom: var(--oy); display: flex; align-items: center; gap: 10px;
  height: 56px; min-width: 56px; padding: 0 16px; justify-content: center;
  background: var(--accent); color: var(--accent-fg);
  border-radius: calc(var(--r) * 2.2); box-shadow: var(--shadow);
  transition: transform .18s cubic-bezier(.2,.8,.2,1), box-shadow .18s, opacity .18s;
}
.launcher.icon-only { width: 56px; padding: 0; border-radius: 999px; }
.launcher:hover { transform: translateY(-2px) scale(1.03); }
.launcher:active { transform: scale(.97); }
.launcher .label { font-weight: 600; font-size: 14px; white-space: nowrap; }
.launcher .ico { display: grid; place-items: center; transition: transform .25s cubic-bezier(.2,.8,.2,1), opacity .2s; }
.launcher.open .ico.main { transform: rotate(-30deg) scale(.6); opacity: 0; position: absolute; }
.launcher .ico.alt { position: absolute; transform: rotate(30deg) scale(.6); opacity: 0; }
.launcher.open .ico.alt { position: static; transform: none; opacity: 1; }
.launcher.open .label { display: none; }
.launcher.open { width: 56px; padding: 0; border-radius: 999px; }
.side-right { right: var(--ox); }
.side-left { left: var(--ox); }
.badge {
  position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 6px;
  border-radius: 999px; background: #ef4444; color: #fff; font-size: 11px; font-weight: 700;
  display: grid; place-items: center; border: 2px solid var(--bg); line-height: 1;
}
.hidden { display: none !important; }

/* ----------------------------------------------------------- panel */
.panel {
  position: fixed; z-index: 2147483001; bottom: calc(var(--oy) + 70px);
  width: 380px; height: min(640px, calc(100vh - var(--oy) - 96px)); max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow);
  transform-origin: bottom right; opacity: 0; transform: translateY(12px) scale(.98); pointer-events: none;
  transition: opacity .2s ease, transform .22s cubic-bezier(.2,.8,.2,1);
}
.side-left.panel { transform-origin: bottom left; }
.panel.open { opacity: 1; transform: none; pointer-events: auto; }
.root.no-launcher .panel { bottom: var(--oy); }

.head {
  position: relative; flex-shrink: 0; padding: 18px 18px 16px;
  background: var(--accent); color: var(--accent-fg);
}
.head.compact { padding: 12px 12px 12px 10px; display: flex; align-items: center; gap: 10px; }
.head .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.head .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.head .names { min-width: 0; }
.head .names b { display: block; font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .names span { display: block; font-size: 12px; opacity: .78; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head h2 { margin: 18px 0 4px; font-size: 22px; line-height: 1.2; font-weight: 700; letter-spacing: -.02em; }
.head p { margin: 0; font-size: 13.5px; opacity: .82; line-height: 1.45; }
.hbtn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: calc(var(--r) * .6); opacity: .85; flex-shrink: 0; }
.hbtn:hover { opacity: 1; background: color-mix(in srgb, var(--accent-fg) 12%, transparent); }
.avatar {
  width: 34px; height: 34px; border-radius: 999px; flex-shrink: 0; overflow: hidden; display: grid; place-items: center;
  background: color-mix(in srgb, var(--accent-fg) 16%, transparent); font-size: 12px; font-weight: 700;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
i.dot { width: 7px; height: 7px; border-radius: 99px; background: #22c55e; display: inline-block; margin-right: 6px; vertical-align: 1px; }

.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 8px; border: 2px solid var(--bg); }

/* ----------------------------------------------------------- home */
.home { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--bg); border: 1px solid var(--line); border-radius: calc(var(--r) * .8); overflow: hidden; }
.card-title { padding: 12px 14px 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.conv { width: 100%; display: flex; gap: 10px; padding: 10px 14px; text-align: left; align-items: center; border-top: 1px solid var(--line); }
.conv:first-of-type { border-top: 0; }
.conv:hover { background: var(--bg-2); }
.conv .meta { flex: 1; min-width: 0; }
.conv .top { display: flex; justify-content: space-between; gap: 8px; }
.conv .top b { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .top span { font-size: 11.5px; color: var(--muted); flex-shrink: 0; }
.conv .pv { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv.unread .pv { color: var(--fg); font-weight: 500; }
.conv .pip { width: 8px; height: 8px; border-radius: 99px; background: var(--accent); flex-shrink: 0; }
.conv .st { font-size: 10.5px; padding: 1px 6px; border-radius: 99px; background: var(--bg-3); color: var(--muted); margin-left: 6px; text-transform: capitalize; }
.newbtn {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
  padding: 14px; font-weight: 600; font-size: 14px; border-radius: calc(var(--r) * .8);
  background: var(--bg); border: 1px solid var(--line);
}
.newbtn:hover { border-color: var(--line-2); }
.newbtn .go { width: 28px; height: 28px; border-radius: 99px; display: grid; place-items: center; background: var(--accent); color: var(--accent-fg); }

/* ----------------------------------------------------------- chat */
.msgs { padding: 16px 14px 8px; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; gap: 8px; align-items: flex-end; max-width: 100%; }
.msg.me { justify-content: flex-end; }
.msg .av { width: 26px; height: 26px; border-radius: 99px; flex-shrink: 0; overflow: hidden; display: grid; place-items: center; font-size: 10px; font-weight: 700; background: var(--bg-3); color: var(--fg-2); }
.msg .av.ai { background: color-mix(in srgb, var(--accent) 22%, var(--bg)); color: color-mix(in srgb, var(--accent) 55%, var(--fg)); }
.msg .av img { width: 100%; height: 100%; object-fit: cover; }
.msg .col { display: flex; flex-direction: column; gap: 3px; max-width: 78%; min-width: 0; }
.msg.me .col { align-items: flex-end; }
.msg .who { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 4px; padding: 0 4px; }
.msg .who svg { color: var(--accent); }
.bubble {
  padding: 9px 12px; border-radius: calc(var(--r) * .9); background: var(--bubble-them); color: var(--fg);
  word-wrap: break-word; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5;
}
.msg.them .bubble { border-bottom-left-radius: calc(var(--r) * .3); }
.msg.ai .bubble { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); }
.msg.me .bubble { background: var(--accent); color: var(--accent-fg); border-bottom-right-radius: calc(var(--r) * .3); }
.msg.pending .bubble { opacity: .6; }
.msg.failed .bubble { outline: 1px solid #ef4444; }
.bubble p { margin: 0 0 6px; } .bubble p:last-child { margin: 0; }
.bubble ul, .bubble ol { margin: 4px 0 6px; padding-left: 18px; }
.bubble code { font-family: ui-monospace, Menlo, monospace; font-size: .88em; background: color-mix(in srgb, currentColor 10%, transparent); padding: 1px 4px; border-radius: 4px; }
.bubble a { text-decoration: underline; text-underline-offset: 2px; }
.time { font-size: 11px; color: var(--muted); padding: 0 4px; }
.sys { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }
.typing { display: inline-flex; gap: 4px; align-items: center; padding: 12px 14px; }
.typing i { width: 6px; height: 6px; border-radius: 99px; background: var(--muted); animation: blink 1.2s infinite ease-in-out; }
.typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 14px 10px 48px; }
.chip {
  padding: 6px 11px; border-radius: 999px; font-size: 13px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line-2));
  color: var(--fg); background: var(--bg);
}
.chip:hover { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }

/* ----------------------------------------------------------- composer */
.composer { flex-shrink: 0; border-top: 1px solid var(--line); padding: 10px 10px 10px 14px; background: var(--bg); }
.composer .email { width: 100%; border: 1px solid var(--line-2); border-radius: calc(var(--r) * .55); padding: 8px 10px; background: var(--bg); margin-bottom: 8px; outline: none; font-size: 13.5px; }
.composer .email:focus { border-color: var(--accent); }
.composer .row { display: flex; align-items: flex-end; gap: 8px; }
.composer textarea {
  flex: 1; resize: none; border: 0; outline: none; background: transparent; min-height: 22px; max-height: 120px;
  padding: 6px 0; font-size: 14px; line-height: 1.45;
}
.composer textarea::placeholder, .composer .email::placeholder { color: var(--muted); }
.sendbtn {
  width: 34px; height: 34px; border-radius: calc(var(--r) * .6); flex-shrink: 0; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-fg); transition: opacity .15s, transform .15s;
}
.sendbtn:disabled { opacity: .35; cursor: default; }
.sendbtn:not(:disabled):hover { transform: translateY(-1px); }
.hint { font-size: 11.5px; color: #ef4444; padding: 0 0 6px; }
.foot { flex-shrink: 0; text-align: center; font-size: 11px; color: var(--muted); padding: 0 0 8px; background: var(--bg); }
.foot a { text-decoration: none; font-weight: 600; }
.foot a:hover { text-decoration: underline; }
.resolved { margin: 6px 14px 10px; padding: 10px 12px; border-radius: calc(var(--r) * .7); background: var(--bg-2); font-size: 12.5px; color: var(--muted); text-align: center; }

/* ----------------------------------------------------------- mobile */
@media (max-width: 480px) {
  .root:not(.no-fs) .panel {
    left: 0 !important; right: 0 !important; bottom: 0 !important; top: 0; width: 100vw; height: 100%; max-height: none;
    border-radius: 0; border: 0;
  }
  .root:not(.no-fs) .launcher.open { display: none; }
}
@media (prefers-reduced-motion: reduce) { .panel, .launcher, .launcher .ico { transition: none; } }
`;
