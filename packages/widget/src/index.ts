import { Api, ApiError } from "./api";
import { icons } from "./icons";
import { css } from "./styles";
import type { Conversation, Identity, Runtime, WidgetConfig, WidgetSettings, WMessage } from "./types";
import { esc, h, initials, markdown, readableOn, store, timeLabel } from "./util";

type Listener = (payload: unknown) => void;
type View = "home" | "chat";
interface Persisted {
  visitorId?: string;
  token?: string;
  seen?: Record<string, string>;
  email?: string;
}

const NEW = "__new__";

class TraceWidget {
  private readonly api: Api;
  private cfg!: WidgetConfig;
  private overrides: Partial<WidgetSettings> = {};
  private runtime: Runtime = {};
  private host!: HTMLDivElement;
  private shadow!: ShadowRoot;
  private root!: HTMLDivElement;
  private customStyle!: HTMLStyleElement;
  private launcher!: HTMLButtonElement;
  private panel!: HTMLDivElement;

  private isOpen = false;
  private view: View = "chat";
  private current: string = NEW;
  private convs: Conversation[] = [];
  private msgs = new Map<string, WMessage[]>();
  private awaiting = new Map<string, number>();
  private identity: Identity = {};
  private persisted: Persisted;
  private listeners = new Map<string, Set<Listener>>();
  private es: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private hint = "";
  private sending = false;
  private destroyed = false;
  private mq = window.matchMedia?.("(prefers-color-scheme: dark)");

  constructor(
    base: string,
    readonly key: string,
    private readonly script: HTMLScriptElement | null,
  ) {
    this.api = new Api(base, key);
    this.persisted = store.get<Persisted>(this.storageKey) ?? {};
    this.api.token = this.persisted.token ?? null;
  }

  private get storageKey() {
    return `trace:widget:${this.key}`;
  }

  private persist(patch: Partial<Persisted>) {
    this.persisted = { ...this.persisted, ...patch };
    store.set(this.storageKey, this.persisted);
  }

  get s(): WidgetSettings {
    return { ...this.cfg.widget, ...this.overrides };
  }

  // ------------------------------------------------------------------ boot

  async boot() {
    this.cfg = await this.api.config();
    const d = this.script?.dataset ?? {};
    if (d.position === "left" || d.position === "right") this.overrides.position = d.position;
    if (d.accent) this.overrides.accentColor = d.accent;
    if (d.theme === "light" || d.theme === "dark" || d.theme === "auto") this.overrides.theme = d.theme;
    if (d.hideLauncher !== undefined && d.hideLauncher !== "false") this.runtime.hideLauncher = true;
    if (d.noFullscreen !== undefined && d.noFullscreen !== "false") this.runtime.noFullscreen = true;

    this.mount();
    this.mq?.addEventListener?.("change", () => this.applyTheme());
    document.addEventListener("click", this.onDocClick, true);

    if (this.api.token) {
      await this.loadConversations().catch((err) => {
        if (err instanceof ApiError && err.status === 401) this.resetSession();
      });
      if (this.convs.length) this.connect();
    }
    if (d.open !== undefined && d.open !== "false") this.open();
  }

  private onDocClick = (e: Event) => {
    const t = e.target as Element | null;
    const trigger = t?.closest?.("[data-trace-open]");
    if (trigger) {
      e.preventDefault();
      this.open();
    }
  };

  private mount() {
    this.host = h("div", { id: "trace-widget", "data-trace": "" });
    this.host.style.cssText = "position:relative;z-index:2147483000;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    const base = h("style");
    base.textContent = css;
    this.customStyle = h("style");
    this.root = h("div", { class: "root" });
    this.launcher = h("button", { class: "launcher", type: "button", "aria-label": "Open support chat" });
    this.launcher.addEventListener("click", () => this.toggle());
    this.panel = h("div", { class: "panel", role: "dialog", "aria-label": "Support chat" });
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.root.append(this.panel, this.launcher);
    this.shadow.append(base, this.root, this.customStyle);
    document.body.appendChild(this.host);
    this.applyTheme();
    this.renderLauncher();
    this.render();
  }

  // ------------------------------------------------------------------ theming

  private applyTheme() {
    const s = this.s;
    const r = this.root.style;
    const accent = s.accentColor || "#b9a3ff";
    r.setProperty("--accent", accent);
    // An accent overridden at runtime (data-accent / Trace('update')) gets an automatic readable foreground.
    const autoFg = !!this.overrides.accentColor && !this.overrides.accentForeground;
    r.setProperty("--accent-fg", (!autoFg && s.accentForeground) || readableOn(accent));
    r.setProperty("--r", `${Math.max(0, Math.min(28, Number(s.radius ?? 14)))}px`);
    r.setProperty("--ox", `${Number(s.offsetX ?? 20)}px`);
    r.setProperty("--oy", `${Number(s.offsetY ?? 20)}px`);
    if (s.fontFamily) r.setProperty("--font", `${s.fontFamily}, ui-sans-serif, system-ui, sans-serif`);
    else r.removeProperty("--font");
    const dark = s.theme === "dark" || (s.theme === "auto" && !!this.mq?.matches);
    this.root.dataset.theme = dark ? "dark" : "light";
    const side = s.position === "left" ? "side-left" : "side-right";
    for (const el of [this.launcher, this.panel]) {
      el.classList.remove("side-left", "side-right");
      el.classList.add(side);
    }
    this.root.classList.toggle("no-launcher", !!this.runtime.hideLauncher);
    this.root.classList.toggle("no-fs", !!this.runtime.noFullscreen);
    this.launcher.classList.toggle("hidden", !!this.runtime.hideLauncher);
    this.customStyle.textContent = s.customCss || "";
  }

  private renderLauncher() {
    const s = this.s;
    const label = (s.launcherText || "").trim();
    const icon = icons[s.launcherIcon] ?? icons.chat;
    const unread = this.unreadCount();
    this.launcher.classList.toggle("icon-only", !label);
    this.launcher.classList.toggle("open", this.isOpen);
    this.launcher.setAttribute("aria-label", this.isOpen ? "Close support chat" : "Open support chat");
    this.launcher.innerHTML = `<span class="ico main">${icon(24)}</span><span class="ico alt">${icons.chevronDown(24)}</span>${
      label ? `<span class="label">${esc(label)}</span>` : ""
    }${unread && !this.isOpen ? `<span class="badge">${unread > 9 ? "9+" : unread}</span>` : ""}`;
  }

  // ------------------------------------------------------------------ state helpers

  private agentName() {
    return this.s.agentName || this.cfg.ai.agentName || this.cfg.org.name;
  }

  private isUnread(c: Conversation) {
    if (!c.lastAuthorType || c.lastAuthorType === "customer") return false;
    const seen = this.persisted.seen?.[c.id];
    return !seen || new Date(c.lastMessageAt) > new Date(seen);
  }

  private unreadCount() {
    return this.convs.filter((c) => this.isUnread(c) && !(this.isOpen && this.view === "chat" && this.current === c.id))
      .length;
  }

  private markSeen(id: string) {
    const c = this.convs.find((x) => x.id === id);
    if (!c) return;
    this.persist({ seen: { ...this.persisted.seen, [id]: c.lastMessageAt } });
  }

  private resetSession() {
    this.api.token = null;
    this.persist({ token: undefined });
    this.convs = [];
    this.msgs.clear();
  }

  private ensureSession(): Promise<void> {
    if (this.api.token) return Promise.resolve();
    if (!this.sessionPromise) {
      this.sessionPromise = this.api
        .session({ visitorId: this.persisted.visitorId, ...this.identity })
        .then((r) => {
          this.api.token = r.token;
          this.persist({ visitorId: r.visitorId, token: r.token });
        })
        .finally(() => {
          this.sessionPromise = null;
        });
    }
    return this.sessionPromise;
  }

  private async loadConversations() {
    if (!this.api.token) return;
    const { conversations } = await this.api.conversations();
    this.convs = conversations;
    this.renderLauncher();
    if (this.isOpen && this.view === "home") this.render();
  }

  private async loadMessages(id: string) {
    const { conversation, messages } = await this.api.messages(id);
    this.msgs.set(id, messages);
    this.upsertConv(conversation);
    if (this.current === id) this.renderMessages(true);
  }

  private upsertConv(c: Partial<Conversation> & { id: string }) {
    const i = this.convs.findIndex((x) => x.id === c.id);
    if (i >= 0) this.convs[i] = { ...this.convs[i]!, ...c };
    else this.convs.unshift(c as Conversation);
    this.convs.sort((a, b) => +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt));
  }

  private emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error("[trace] listener error", err);
      }
    });
  }

  // ------------------------------------------------------------------ realtime

  private connect() {
    if (this.destroyed || !this.api.token || typeof EventSource === "undefined") {
      this.startPolling();
      return;
    }
    this.es?.close();
    const es = new EventSource(this.api.streamUrl());
    this.es = es;
    es.addEventListener("ready", () => this.stopPolling());
    es.addEventListener("message", (ev) => this.onStreamMessage(JSON.parse((ev as MessageEvent).data) as WMessage));
    es.addEventListener("conversation", (ev) => {
      const c = JSON.parse((ev as MessageEvent).data) as Conversation;
      this.upsertConv(c);
      if (this.current === c.id) this.renderTyping();
      if (this.isOpen && this.view === "home") this.render();
    });
    es.onerror = () => {
      // EventSource reconnects by itself; if the browser gave up, poll and retry later.
      if (es.readyState === EventSource.CLOSED) {
        this.startPolling();
        setTimeout(() => this.es === es && this.connect(), 30_000);
      }
    };
  }

  private startPolling() {
    if (this.poll || this.destroyed) return;
    this.poll = setInterval(() => {
      this.loadConversations().catch(() => {});
      if (this.isOpen && this.current !== NEW) this.loadMessages(this.current).catch(() => {});
    }, 6000);
  }

  private stopPolling() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private onStreamMessage(m: WMessage) {
    const list = this.msgs.get(m.ticketId);
    if (list && !list.some((x) => x.id === m.id)) {
      // Replace an optimistic copy of our own message if the stream beats the POST response.
      const pi = m.authorType === "customer" ? list.findIndex((x) => x.pending && x.body === m.body) : -1;
      if (pi >= 0) list[pi] = m;
      else list.push(m);
    }
    const known = this.convs.some((c) => c.id === m.ticketId);
    this.upsertConv({
      id: m.ticketId,
      lastMessageAt: m.createdAt,
      preview: m.body.slice(0, 140),
      lastAuthorType: m.authorType,
      lastAuthorName: m.authorName,
    });
    if (!known) this.loadConversations().catch(() => {});
    if (m.authorType !== "customer") {
      this.awaiting.delete(m.ticketId);
      this.emit("message", m);
    }
    const visible = this.isOpen && this.view === "chat" && this.current === m.ticketId;
    if (visible) {
      this.markSeen(m.ticketId);
      this.renderMessages(true);
    } else if (this.isOpen && this.view === "home") {
      this.render();
    }
    this.renderLauncher();
  }

  // ------------------------------------------------------------------ commands

  open() {
    if (this.isOpen || this.destroyed) return;
    this.isOpen = true;
    if (this.view === "chat" && this.current === NEW && this.convs.length) this.view = "home";
    this.panel.classList.add("open");
    this.render();
    this.renderLauncher();
    if (this.view === "chat" && this.current !== NEW) {
      this.markSeen(this.current);
      if (!this.msgs.has(this.current)) this.loadMessages(this.current).catch(() => {});
    }
    this.emit("open", null);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.classList.remove("open");
    this.renderLauncher();
    this.emit("close", null);
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  async identify(identity: Identity) {
    this.identity = { ...this.identity, ...identity };
    if (identity.email) this.persist({ email: identity.email });
    const r = await this.api.session({
      visitorId: this.persisted.visitorId,
      token: this.api.token ?? undefined,
      ...this.identity,
    });
    this.api.token = r.token;
    this.persist({ visitorId: r.visitorId, token: r.token });
    await this.loadConversations();
    if (this.convs.length) this.connect();
    if (this.isOpen) this.render();
  }

  update(patch: Record<string, unknown>) {
    const overrides = (patch.settingsOverrides as Partial<WidgetSettings>) ?? (patch as Partial<WidgetSettings>);
    this.overrides = { ...this.overrides, ...overrides };
    if (typeof patch.hideLauncher === "boolean") this.runtime.hideLauncher = patch.hideLauncher;
    this.applyTheme();
    this.renderLauncher();
    this.render();
  }

  on(event: string, cb: Listener) {
    if (typeof cb !== "function") return;
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  off(event: string, cb: Listener) {
    this.listeners.get(event)?.delete(cb);
  }

  shutdown() {
    this.destroyed = true;
    this.es?.close();
    this.stopPolling();
    document.removeEventListener("click", this.onDocClick, true);
    store.del(this.storageKey);
    this.host.remove();
  }

  command(cmd: string, args: unknown[]) {
    switch (cmd) {
      case "open":
      case "show":
        return this.open();
      case "close":
      case "hide":
        return this.close();
      case "toggle":
        return this.toggle();
      case "identify":
        return this.identify((args[0] as Identity) ?? {}).catch((e) =>
          console.warn("[trace] identify failed:", e.message),
        );
      case "update":
        return this.update((args[0] as Record<string, unknown>) ?? {});
      case "on":
        return this.on(String(args[0]), args[1] as Listener);
      case "off":
        return this.off(String(args[0]), args[1] as Listener);
      case "hideLauncher":
        return this.update({ hideLauncher: true });
      case "showLauncher":
        return this.update({ hideLauncher: false });
      case "shutdown":
        return this.shutdown();
      default:
        console.warn(`[trace] unknown command "${cmd}"`);
    }
  }

  // ------------------------------------------------------------------ rendering

  private avatarHtml(cls = "avatar") {
    const s = this.s;
    const src = s.avatarUrl || this.cfg.org.logo;
    return `<span class="${cls}">${src ? `<img src="${esc(src)}" alt="">` : esc(initials(this.agentName()))}</span>`;
  }

  private statusLine() {
    const aiOn = this.cfg.ai.enabled && (this.s.aiInstantAnswers ?? true);
    return aiOn
      ? `<i class="dot"></i>AI answers instantly · team on standby`
      : `<i class="dot"></i>We typically reply in a few minutes`;
  }

  private render() {
    if (!this.isOpen) {
      // Keep the DOM light while closed; rebuilt on open.
      if (!this.panel.childElementCount) this.panel.innerHTML = "";
      return;
    }
    const s = this.s;
    this.panel.innerHTML = "";
    if (this.view === "home") {
      const head = h(
        "div",
        { class: "head" },
        `<div class="row"><div class="who">${this.avatarHtml()}<div class="names"><b>${esc(this.agentName())}</b><span>${this.statusLine()}</span></div></div><button class="hbtn" data-act="close" aria-label="Close">${icons.close()}</button></div><h2>${esc(s.title)}</h2><p>${esc(s.subtitle)}</p>`,
      );
      const body = h("div", { class: "body" });
      const home = h("div", { class: "home" });
      const newBtn = h(
        "button",
        { class: "newbtn", type: "button", "data-act": "new" },
        `<span>Send us a message<br><span style="font-weight:400;font-size:12.5px;color:var(--muted)">${esc(this.statusLine().replace(/<[^>]+>/g, ""))}</span></span><span class="go">${icons.arrowRight()}</span>`,
      );
      home.append(newBtn);
      if (this.convs.length) {
        const card = h("div", { class: "card" }, `<div class="card-title">Your conversations</div>`);
        for (const c of this.convs.slice(0, 20)) {
          const unread = this.isUnread(c);
          const who = c.lastAuthorType === "customer" ? "You" : c.lastAuthorName || this.agentName();
          const row = h(
            "button",
            { class: `conv${unread ? " unread" : ""}`, type: "button", "data-conv": c.id },
            `<span class="msg"><span class="av ${c.lastAuthorType === "ai" ? "ai" : ""}">${
              c.lastAuthorType === "customer" ? esc(initials(this.identity.name || "You")) : esc(initials(who))
            }</span></span><span class="meta"><span class="top"><b>${esc(c.subject)}</b><span>${esc(timeLabel(c.lastMessageAt))}</span></span><span class="pv">${esc(
              who,
            )}: ${esc(c.preview || "")}${c.status === "resolved" || c.status === "closed" ? `<span class="st">${esc(c.status)}</span>` : ""}</span></span>${
              unread ? `<span class="pip"></span>` : ""
            }`,
          );
          card.append(row);
        }
        home.append(card);
      }
      body.append(home);
      this.panel.append(head, body);
    } else {
      const canBack = this.convs.length > 0;
      const head = h(
        "div",
        { class: "head compact" },
        `${canBack ? `<button class="hbtn" data-act="back" aria-label="Back">${icons.back()}</button>` : ""}<div class="who" style="flex:1">${this.avatarHtml()}<div class="names"><b>${esc(
          this.current === NEW
            ? this.agentName()
            : (this.convs.find((c) => c.id === this.current)?.subject ?? this.agentName()),
        )}</b><span>${this.statusLine()}</span></div></div><button class="hbtn" data-act="close" aria-label="Close">${icons.close()}</button>`,
      );
      const body = h("div", { class: "body" });
      body.append(h("div", { class: "msgs" }), h("div", { class: "chips" }));
      this.panel.append(head, body, this.composer());
      this.renderMessages(true);
    }
    if (s.showPoweredBy) {
      this.panel.append(
        h(
          "div",
          { class: "foot" },
          `Powered by <a href="https://github.com/trace-helpdesk/trace" target="_blank" rel="noopener">trace</a>`,
        ),
      );
    }
    this.panel.querySelectorAll<HTMLElement>("[data-act]").forEach((el) =>
      el.addEventListener("click", () => {
        const act = el.dataset.act;
        if (act === "close") this.close();
        if (act === "back") {
          this.view = "home";
          this.render();
          this.loadConversations().catch(() => {});
        }
        if (act === "new") {
          this.view = "chat";
          this.current = NEW;
          this.render();
        }
      }),
    );
    this.panel
      .querySelectorAll<HTMLElement>("[data-conv]")
      .forEach((el) => el.addEventListener("click", () => this.openConversation(el.dataset.conv!)));
  }

  private openConversation(id: string) {
    this.view = "chat";
    this.current = id;
    this.hint = "";
    this.render();
    this.markSeen(id);
    this.renderLauncher();
    this.loadMessages(id).catch(() => {});
  }

  private composer() {
    const s = this.s;
    const wrap = h("div", { class: "composer" });
    const needsEmail = s.requireEmail && this.current === NEW && !this.identity.email && !this.persisted.email;
    if (this.hint) wrap.append(h("div", { class: "hint" }, esc(this.hint)));
    let email: HTMLInputElement | null = null;
    if (needsEmail) {
      email = h("input", {
        class: "email",
        type: "email",
        placeholder: "Your email — so we can follow up",
        autocomplete: "email",
      });
      wrap.append(email);
    }
    const row = h("div", { class: "row" });
    const ta = h("textarea", {
      rows: "1",
      placeholder: this.current === NEW ? "Ask a question…" : "Write a reply…",
      "aria-label": "Message",
    });
    const btn = h("button", { class: "sendbtn", type: "button", "aria-label": "Send", disabled: true }, icons.send());
    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
      btn.disabled = !ta.value.trim() || this.sending;
    };
    ta.addEventListener("input", autosize);
    const submit = () => {
      const text = ta.value.trim();
      if (!text || this.sending) return;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
        this.hint = "Please enter a valid email so we can get back to you.";
        email.focus();
        const hintEl = wrap.querySelector(".hint");
        if (hintEl) hintEl.textContent = this.hint;
        else wrap.prepend(h("div", { class: "hint" }, esc(this.hint)));
        return;
      }
      ta.value = "";
      autosize();
      this.send(text, email?.value.trim() || undefined);
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    btn.addEventListener("click", submit);
    row.append(ta, btn);
    wrap.append(row);
    setTimeout(() => (email && !email.value ? email : ta).focus({ preventScroll: true }), 30);
    return wrap;
  }

  private renderMessages(scroll = false) {
    const box = this.panel.querySelector<HTMLDivElement>(".msgs");
    const chips = this.panel.querySelector<HTMLDivElement>(".chips");
    if (!box) return;
    const s = this.s;
    const list = this.current === NEW ? (this.msgs.get(NEW) ?? []) : (this.msgs.get(this.current) ?? []);
    const parts: string[] = [];
    if (s.greeting) {
      parts.push(
        this.messageHtml(
          {
            id: "greet",
            ticketId: "",
            authorType: "agent",
            authorName: this.agentName(),
            body: s.greeting,
            createdAt: "",
          },
          true,
          true,
        ),
      );
    }
    list.forEach((m, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      const showName = !prev || prev.authorType !== m.authorType || prev.authorName !== m.authorName;
      const showTime =
        !next || next.authorType !== m.authorType || +new Date(next.createdAt) - +new Date(m.createdAt) > 5 * 60_000;
      parts.push(this.messageHtml(m, showName, showTime));
    });
    const conv = this.convs.find((c) => c.id === this.current);
    if (conv && (conv.status === "resolved" || conv.status === "closed")) {
      parts.push(`<div class="resolved">This conversation was marked as resolved. Reply to reopen it.</div>`);
    }
    box.innerHTML = parts.join("");
    if (chips) {
      const show = this.current === NEW && !list.length && s.suggestions?.length;
      chips.innerHTML = show
        ? s.suggestions
            .filter(Boolean)
            .map((t) => `<button class="chip" type="button">${esc(t)}</button>`)
            .join("")
        : "";
      chips.classList.toggle("hidden", !show);
      chips.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) =>
        b.addEventListener("click", () => {
          const ta = this.panel.querySelector("textarea");
          if (s.requireEmail && !this.identity.email && !this.persisted.email) {
            if (ta) {
              ta.value = b.textContent ?? "";
              ta.dispatchEvent(new Event("input"));
            }
            this.panel.querySelector<HTMLInputElement>(".email")?.focus();
            return;
          }
          this.send(b.textContent ?? "");
        }),
      );
    }
    this.renderTyping();
    if (scroll) this.scrollToEnd();
  }

  private messageHtml(m: WMessage, showName: boolean, showTime: boolean) {
    const me = m.authorType === "customer";
    const ai = m.authorType === "ai";
    const cls = `msg ${me ? "me" : "them"}${ai ? " ai" : ""}${m.pending ? " pending" : ""}${m.failed ? " failed" : ""}`;
    const name = ai ? this.agentName() : m.authorName || this.cfg.org.name;
    const av = me
      ? ""
      : `<span class="av ${ai ? "ai" : ""}" style="${showTime ? "" : "visibility:hidden"}">${
          ai
            ? this.s.avatarUrl
              ? `<img src="${esc(this.s.avatarUrl)}" alt="">`
              : icons.sparkle(14)
            : esc(initials(name))
        }</span>`;
    const who =
      !me && showName ? `<span class="who">${ai ? icons.sparkle(11) : ""}${esc(name)}${ai ? " · AI" : ""}</span>` : "";
    const time =
      showTime && m.createdAt
        ? `<span class="time">${m.failed ? "Not delivered — tap send to retry" : m.pending ? "Sending…" : esc(timeLabel(m.createdAt))}</span>`
        : "";
    return `<div class="${cls}">${av}<div class="col">${who}<div class="bubble">${markdown(m.body)}</div>${time}</div></div>`;
  }

  private renderTyping() {
    const box = this.panel.querySelector<HTMLDivElement>(".msgs");
    if (!box) return;
    box.querySelector(".typing-row")?.remove();
    const conv = this.convs.find((c) => c.id === this.current);
    const since = this.awaiting.get(this.current);
    const waiting = since !== undefined && Date.now() - since < 25_000;
    if (conv?.aiState === "processing" || (waiting && this.cfg.ai.enabled && this.s.aiInstantAnswers)) {
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="msg them ai typing-row"><span class="av ai">${icons.sparkle(14)}</span><div class="col"><div class="bubble typing"><i></i><i></i><i></i></div></div></div>`,
      );
      if (waiting) setTimeout(() => this.renderTyping(), 25_500 - (Date.now() - since!));
      this.scrollToEnd();
    }
  }

  private scrollToEnd() {
    const body = this.panel.querySelector<HTMLDivElement>(".body");
    if (body) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  }

  // ------------------------------------------------------------------ sending

  private async send(text: string, email?: string) {
    if (this.sending) return;
    this.sending = true;
    this.hint = "";
    const temp: WMessage = {
      id: `tmp_${Date.now()}`,
      ticketId: this.current,
      authorType: "customer",
      authorName: null,
      body: text,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    const key = this.current;
    const list = this.msgs.get(key) ?? [];
    list.push(temp);
    this.msgs.set(key, list);
    this.renderMessages(true);
    try {
      if (email) {
        this.identity.email = email;
        this.persist({ email });
      }
      await this.ensureSession();
      if (key === NEW) {
        const r = await this.api.start({
          body: text,
          email: email ?? this.identity.email ?? this.persisted.email,
          name: this.identity.name,
        });
        this.api.token = r.token;
        this.persist({ token: r.token });
        this.msgs.delete(NEW);
        const real = r.message ?? { ...temp, pending: false };
        this.msgs.set(r.conversation.id, [{ ...real, ticketId: r.conversation.id }]);
        this.upsertConv({ ...r.conversation, preview: text, lastAuthorType: "customer" });
        this.current = r.conversation.id;
        this.awaiting.set(r.conversation.id, Date.now());
        this.connect();
        this.render();
      } else {
        const r = await this.api.send(key, text);
        const cur = this.msgs.get(key) ?? [];
        const already = cur.some((m) => m.id === r.message.id);
        this.msgs.set(
          key,
          already ? cur.filter((m) => m.id !== temp.id) : cur.map((m) => (m.id === temp.id ? r.message : m)),
        );
        this.upsertConv({ id: key, lastMessageAt: r.message.createdAt, preview: text, lastAuthorType: "customer" });
        this.awaiting.set(key, Date.now());
        if (!this.es) this.connect();
        this.renderMessages(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.resetSession();
      temp.pending = false;
      temp.failed = true;
      this.hint = err instanceof Error ? err.message : "Something went wrong";
      const ta = this.panel.querySelector("textarea");
      if (this.current === key) {
        this.render();
        const nta = this.panel.querySelector("textarea");
        if (nta && !ta?.value) {
          nta.value = text;
          nta.dispatchEvent(new Event("input"));
        }
        const l = this.msgs.get(key);
        if (l)
          this.msgs.set(
            key,
            l.filter((m) => m.id !== temp.id),
          );
        this.renderMessages(true);
      }
    } finally {
      this.sending = false;
      const btn = this.panel.querySelector<HTMLButtonElement>(".sendbtn");
      const ta = this.panel.querySelector("textarea");
      if (btn && ta) btn.disabled = !ta.value.trim();
    }
  }
}

// -------------------------------------------------------------------- global entry

type TraceFn = ((cmd: string, ...args: unknown[]) => unknown) & { q?: unknown[][]; __trace?: boolean };

(function init() {
  const w = window as unknown as { Trace?: TraceFn };
  if (w.Trace?.__trace) return; // already loaded

  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-key][src*="widget"]');
  const key = script?.dataset.key ?? "";
  if (!key) {
    console.warn("[trace] missing data-key on the widget <script> tag");
    return;
  }
  const base = script?.src ? new URL(script.src, location.href).origin : location.origin;
  const queued: unknown[][] = (w.Trace?.q ?? []).map((a) => Array.from(a as ArrayLike<unknown>));
  let widget: TraceWidget | null = null;

  const fn: TraceFn = (cmd: string, ...args: unknown[]) => {
    if (widget) return widget.command(cmd, args);
    queued.push([cmd, ...args]);
  };
  fn.__trace = true;
  w.Trace = fn;

  const start = () => {
    const wd = new TraceWidget(base, key, script);
    wd.boot()
      .then(() => {
        widget = wd;
        for (const [cmd, ...args] of queued.splice(0)) wd.command(String(cmd), args);
      })
      .catch((err) => console.warn("[trace] widget failed to load:", err instanceof Error ? err.message : err));
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
