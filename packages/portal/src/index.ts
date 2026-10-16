import { Api, ApiError } from "./api";
import { icons } from "./icons";
import { sampleCounts, sampleCustomer, sampleMessages, sampleTickets } from "./sample";
import { css } from "./styles";
import type { Article, Counts, Customer, Identity, Message, PortalConfig, PortalSettings, Ticket } from "./types";
// Shared with the chat widget: escaping, markdown-lite, small DOM helpers.
import { esc, initials, markdown, readableOn, store, timeLabel } from "../../widget/src/util";

/**
 * <trace-portal>: the customer portal as a web component. The hosted page at /portal/<workspace>
 * uses it too, so anything the hosted portal does works embedded in your own platform.
 *
 *   <trace-portal workspace="acme"></trace-portal>
 *   <script src="https://trace.example.com/portal.js" async></script>
 */

type Tab = "active" | "solved" | "all";
type Route = { name: "list" } | { name: "ticket"; number: number } | { name: "new" } | { name: "signin" };
type Routing = "memory" | "hash" | "path";

interface Stored {
  token: string;
  /** "email": signed in with a link; "platform": signed in by the host page (re-identified on every load). */
  kind: "email" | "platform";
}

const ATTRS = [
  "workspace",
  "server",
  "layout",
  "routing",
  "base-path",
  "theme",
  "accent",
  "radius",
  "font",
  "hide-header",
  "preview",
  "user-email",
  "user-id",
  "user-name",
  "user-hash",
] as const;

const CHANNELS: Record<string, string> = {
  email: "Email",
  widget: "Chat",
  portal: "Support portal",
  slack: "Slack",
  discord: "Discord",
  api: "API",
  web: "Our team",
};

const STATE_LABEL = { open: "Open", awaiting_you: "Awaiting your reply", solved: "Solved" } as const;

const scriptEl =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>('script[src*="portal.js"]');
const scriptOrigin = scriptEl?.src ? new URL(scriptEl.src, location.href).origin : location.origin;

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
};
const fmtDateTime = (iso: string) =>
  `${fmtDate(iso)}, ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

export class TracePortalElement extends HTMLElement {
  static observedAttributes = ATTRS;

  private shadow: ShadowRoot;
  private root: HTMLDivElement;
  private customStyle: HTMLStyleElement;
  private api!: Api;
  private cfg: PortalConfig | null = null;
  private overrides: Partial<PortalSettings> = {};
  private booted = false;
  private booting: Promise<void> | null = null;
  private mq = window.matchMedia?.("(prefers-color-scheme: dark)");

  private token: string | null = null;
  private scope: "all" | "ticket" = "all";
  private customer: Customer | null = null;
  private pendingIdentity: Identity | null = null;

  private route: Route = { name: "list" };
  private memPath = "/";
  private tab: Tab = "active";
  private tickets: Ticket[] | null = null;
  private counts: Counts | null = null;
  private current: { ticket: Ticket; messages: Message[] } | null = null;
  private loadError = "";
  private menuOpen = false;
  private sentTo = "";
  private busy = false;
  private answers: Article[] = [];
  private answersFor = "";
  private expanded = "";
  private poll: ReturnType<typeof setTimeout> | null = null;
  /** Poll quickly for a little while after a reply, so an instant AI answer shows up right away. */
  private fastUntil = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    const base = document.createElement("style");
    base.textContent = css;
    this.customStyle = document.createElement("style");
    this.root = document.createElement("div");
    this.root.className = "root";
    this.root.setAttribute("part", "root");
    this.shadow.append(base, this.root, this.customStyle);
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("submit", this.onSubmit);
    this.root.addEventListener("input", this.onInput);
  }

  // ------------------------------------------------------------------ lifecycle

  connectedCallback() {
    window.addEventListener("popstate", this.onLocation);
    window.addEventListener("hashchange", this.onLocation);
    document.addEventListener("visibilitychange", this.onVisible);
    this.mq?.addEventListener?.("change", this.applyTheme);
    if (!this.booted && !this.booting) this.booting = this.boot().finally(() => (this.booting = null));
    else this.schedulePoll();
  }

  disconnectedCallback() {
    window.removeEventListener("popstate", this.onLocation);
    window.removeEventListener("hashchange", this.onLocation);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.mq?.removeEventListener?.("change", this.applyTheme);
    this.stopPoll();
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null) {
    if (!this.booted || prev === next) return;
    if (name.startsWith("user-")) {
      const id = this.identityFromAttributes();
      if (id) this.identify(id).catch(() => {});
      return;
    }
    this.applyTheme();
    this.render();
  }

  private get workspace() {
    return this.getAttribute("workspace") ?? "";
  }

  private get preview() {
    return this.hasAttribute("preview");
  }

  private get layout(): "page" | "embed" {
    return this.getAttribute("layout") === "page" ? "page" : "embed";
  }

  private get routing(): Routing {
    const r = this.getAttribute("routing");
    if (r === "hash" || r === "path" || r === "memory") return r;
    return "memory";
  }

  private get basePath() {
    return (this.getAttribute("base-path") ?? "").replace(/\/+$/, "");
  }

  private get storageKey() {
    return `trace:portal:${this.workspace}@${this.api.base}`;
  }

  private get s(): PortalSettings {
    const base = this.cfg?.portal ?? ({} as PortalSettings);
    const s = { ...base, ...this.overrides };
    const theme = this.getAttribute("theme");
    if (theme === "light" || theme === "dark" || theme === "auto") s.theme = theme;
    const accent = this.getAttribute("accent");
    if (accent) {
      s.accentColor = accent;
      if (!this.overrides.accentForeground) s.accentForeground = "";
    }
    const radius = this.getAttribute("radius");
    if (radius !== null && !Number.isNaN(Number(radius))) s.radius = Number(radius);
    const font = this.getAttribute("font");
    if (font) s.fontFamily = font;
    return s;
  }

  private async boot() {
    if (!this.workspace) {
      console.warn("[trace] <trace-portal> needs a workspace attribute");
      return;
    }
    this.api = new Api((this.getAttribute("server") || scriptOrigin).replace(/\/+$/, ""), this.workspace);
    this.root.innerHTML = `<div class="loading"><span class="spin" aria-label="Loading"></span></div>`;
    this.applyTheme();
    try {
      this.cfg = await this.api.config();
    } catch (err) {
      if (!this.preview) {
        this.root.innerHTML = `<div class="loading">${esc(err instanceof Error ? err.message : "This portal is unavailable")}</div>`;
        return;
      }
      // The settings preview renders even while the portal is switched off.
      this.cfg = {
        portal: {} as PortalSettings,
        org: { name: "Support", logo: null, slug: this.workspace },
        ticketPrefix: "TR",
        demo: null,
      };
    }
    this.booted = true;
    this.applyTheme();

    if (this.preview) {
      this.customer = sampleCustomer;
      this.tickets = sampleTickets(this.cfg.ticketPrefix);
      this.counts = sampleCounts(this.tickets);
    } else {
      await this.restoreSession();
    }
    this.route = this.parse(this.readPath());
    await this.enter();
    this.emit("trace:ready", { signedIn: !!this.token });
  }

  /** Sign-in link code → session; else the host's identity; else a saved session; else a one-ticket email link. */
  private async restoreSession() {
    const url = new URL(location.href);
    const code = url.searchParams.get("trace_code");
    const ticketToken = url.searchParams.get("t");
    if (code || ticketToken) {
      url.searchParams.delete("trace_code");
      url.searchParams.delete("t");
      history.replaceState(history.state, "", url.toString());
    }
    const saved = store.get<Stored>(this.storageKey);
    const identity = this.pendingIdentity ?? this.identityFromAttributes();
    try {
      if (code) {
        const r = await this.api.verify(code);
        this.adopt(r.token, r.customer, "email");
        this.emit("trace:signin", { customer: r.customer, method: "email" });
        return;
      }
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : "Sign-in failed";
    }
    if (identity) {
      await this.identify(identity, { quiet: true }).catch((err) => {
        console.warn("[trace] portal identify failed:", err instanceof Error ? err.message : err);
      });
      if (this.token) return;
    }
    const session = saved?.token ?? null;
    const scoped = ticketToken ?? sessionGet(`${this.storageKey}:t`);
    for (const [token, kind] of [
      [session, "saved"],
      [scoped, "ticket"],
    ] as const) {
      if (!token) continue;
      this.api.token = token;
      try {
        const me = await this.api.me();
        this.token = token;
        this.customer = me.customer;
        this.scope = me.scope;
        if (kind === "ticket") sessionSet(`${this.storageKey}:t`, token);
        return;
      } catch {
        this.api.token = null;
        if (kind === "saved") store.del(this.storageKey);
        else sessionSet(`${this.storageKey}:t`, null);
      }
    }
  }

  private adopt(token: string, customer: Customer | null, kind: Stored["kind"]) {
    this.token = token;
    this.api.token = token;
    this.customer = customer;
    this.scope = "all";
    this.tickets = null;
    store.set(this.storageKey, { token, kind } satisfies Stored);
    sessionSet(`${this.storageKey}:t`, null);
  }

  private identityFromAttributes(): Identity | null {
    const userHash = this.getAttribute("user-hash");
    if (!userHash) return null;
    return {
      userHash,
      email: this.getAttribute("user-email") ?? undefined,
      userId: this.getAttribute("user-id") ?? undefined,
      name: this.getAttribute("user-name") ?? undefined,
    };
  }

  // ------------------------------------------------------------------ public API

  /** Sign the customer in from your platform (HMAC of their email or userId, made on your server). */
  async identify(identity: Identity, opts: { quiet?: boolean } = {}) {
    if (!this.booted && !opts.quiet) {
      this.pendingIdentity = identity;
      return;
    }
    if (this.preview) return;
    const r = await this.api.session(identity);
    this.adopt(r.token, r.customer, "platform");
    this.emit("trace:signin", { customer: r.customer, method: "platform" });
    if (!opts.quiet) await this.enter();
  }

  signOut() {
    store.del(this.storageKey);
    sessionSet(`${this.storageKey}:t`, null);
    this.token = null;
    if (this.api) this.api.token = null;
    this.customer = null;
    this.tickets = null;
    this.current = null;
    this.menuOpen = false;
    this.emit("trace:signout", {});
    this.navigate("/");
  }

  /** Change settings at runtime, e.g. { accentColor: "#0f766e", theme: "dark" }. */
  update(patch: Partial<PortalSettings>) {
    this.overrides = { ...this.overrides, ...patch };
    this.applyTheme();
    if (this.booted) this.render();
  }

  /** Go to "/", "/new" or "/tickets/<number>". */
  navigate(path: string, opts: { replace?: boolean } = {}) {
    const p = path.startsWith("/") ? path : `/${path}`;
    if (this.routing === "memory") this.memPath = p;
    else if (this.routing === "hash") {
      if (opts.replace) history.replaceState(history.state, "", `#${p}`);
      else location.hash = p;
    } else {
      const url = `${this.basePath}${p === "/" ? "" : p}` || "/";
      if (opts.replace) history.replaceState(history.state, "", url);
      else history.pushState(null, "", url);
    }
    this.route = this.parse(p);
    this.emit("trace:navigate", { path: p });
    this.enter().catch(() => {});
  }

  // ------------------------------------------------------------------ routing

  private readPath() {
    if (this.routing === "hash") return location.hash.replace(/^#/, "") || "/";
    if (this.routing === "path") {
      const p = location.pathname;
      const rest = this.basePath && p.startsWith(this.basePath) ? p.slice(this.basePath.length) : p;
      return rest || "/";
    }
    return this.memPath;
  }

  private parse(path: string): Route {
    const m = path.match(/^\/tickets\/(\d+)\/?$/);
    if (m) return { name: "ticket", number: Number(m[1]) };
    if (/^\/new\/?$/.test(path)) return { name: "new" };
    if (/^\/signin\/?$/.test(path) && this.preview) return { name: "signin" };
    return { name: "list" };
  }

  private href(path: string) {
    if (this.routing === "hash") return `#${path}`;
    if (this.routing === "path") return `${this.basePath}${path === "/" ? "" : path}` || "/";
    return "#";
  }

  private onLocation = () => {
    if (this.routing === "memory" || !this.booted) return;
    const next = this.parse(this.readPath());
    if (JSON.stringify(next) === JSON.stringify(this.route)) return;
    this.route = next;
    this.enter().catch(() => {});
  };

  /** Load what the current route needs, then render it. */
  private async enter() {
    this.stopPoll();
    this.menuOpen = false;
    const r = this.route;
    if (!this.token && !this.preview) {
      this.render();
      return;
    }
    if (this.scope === "ticket" && r.name !== "ticket") {
      // A one-ticket email link can't list or open other requests.
      this.render();
      return;
    }
    if (r.name === "ticket") {
      if (this.current?.ticket.number !== r.number) this.current = null;
      this.render();
      await this.loadTicket(r.number);
      this.schedulePoll();
    } else if (r.name === "list") {
      this.render();
      await this.loadTickets();
    } else {
      this.render();
    }
    if (this.layout === "page") window.scrollTo({ top: 0 });
  }

  private async loadTickets() {
    if (this.preview) {
      this.render();
      return;
    }
    const tab = this.tab;
    try {
      const r = await this.api.tickets(tab === "all" ? undefined : tab);
      if (tab !== this.tab) return;
      this.tickets = r.tickets;
      this.counts = r.counts;
      this.loadError = "";
    } catch (err) {
      if (this.unauthorized(err)) return;
      this.loadError = err instanceof Error ? err.message : "Couldn't load your requests";
    }
    if (this.route.name === "list") this.render();
  }

  private async loadTicket(number: number, opts: { quiet?: boolean } = {}) {
    if (this.preview) {
      const ticket = (this.tickets ?? []).find((t) => t.number === number) ?? (this.tickets ?? [])[0];
      if (ticket) this.current = { ticket, messages: sampleMessages(ticket, this.cfg?.org.name ?? "Support") };
      this.render();
      return;
    }
    try {
      const r = await this.api.ticket(number);
      const prev = this.current;
      this.current = r;
      this.loadError = "";
      if (this.route.name !== "ticket" || this.route.number !== number) return;
      const changed =
        !prev ||
        prev.messages.length !== r.messages.length ||
        prev.ticket.status !== r.ticket.status ||
        prev.ticket.working !== r.ticket.working;
      if (!opts.quiet || !prev) this.render();
      else if (changed) this.renderThread();
    } catch (err) {
      if (this.unauthorized(err)) return;
      this.loadError = err instanceof Error ? err.message : "Couldn't load this request";
      if (!opts.quiet) this.render();
    }
  }

  private unauthorized(err: unknown) {
    if (!(err instanceof ApiError) || err.status !== 401) return false;
    this.signOut();
    return true;
  }

  private schedulePoll() {
    this.stopPoll();
    if (this.preview || this.route.name !== "ticket" || !this.token) return;
    const number = this.route.number;
    const delay = this.current?.ticket.working || Date.now() < this.fastUntil ? 2500 : 8000;
    this.poll = setTimeout(async () => {
      if (!document.hidden) await this.loadTicket(number, { quiet: true });
      this.schedulePoll();
    }, delay);
  }

  private stopPoll() {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }

  private onVisible = () => {
    if (!document.hidden && this.route.name === "ticket" && this.token) {
      this.loadTicket(this.route.number, { quiet: true }).catch(() => {});
    }
  };

  // ------------------------------------------------------------------ theming

  private applyTheme = () => {
    const s = this.s;
    const r = this.root.style;
    const accent = s.accentColor || "#b9a3ff";
    r.setProperty("--_accent", accent);
    r.setProperty("--_accent-fg", s.accentForeground || readableOn(accent));
    r.setProperty("--_r", `${Math.max(0, Math.min(28, Number(s.radius ?? 12)))}px`);
    if (s.fontFamily) r.setProperty("--_font", `${s.fontFamily}, ui-sans-serif, system-ui, sans-serif`);
    else r.removeProperty("--_font");
    const dark = s.theme === "dark" || (s.theme !== "light" && !!this.mq?.matches);
    this.root.dataset.theme = dark ? "dark" : "light";
    this.root.classList.toggle("page", this.layout === "page");
    this.root.classList.toggle("embed", this.layout !== "page");
    this.customStyle.textContent = s.customCss || "";
  };

  // ------------------------------------------------------------------ events

  private emit(name: string, detail: unknown, cancelable = false) {
    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable }));
  }

  private onClick = (e: Event) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-nav],[data-act],[data-tab]");
    if (!el) {
      if (this.menuOpen) {
        this.menuOpen = false;
        this.renderHeader();
      }
      return;
    }
    const { nav, act, tab } = el.dataset;
    if (nav !== undefined) {
      const me = e as MouseEvent;
      // Let the browser open real links in a new tab.
      if (this.routing !== "memory" && (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1)) return;
      e.preventDefault();
      this.navigate(nav);
      return;
    }
    if (tab) {
      this.tab = tab as Tab;
      this.tickets = this.preview ? this.tickets : null;
      this.render();
      this.loadTickets().catch(() => {});
      return;
    }
    switch (act) {
      case "menu":
        this.menuOpen = !this.menuOpen;
        this.renderHeader();
        break;
      case "signout":
        this.signOut();
        break;
      case "signin":
        // From a one-ticket link: drop it and show the sign-in form.
        sessionSet(`${this.storageKey}:t`, null);
        this.token = null;
        this.api.token = null;
        this.customer = null;
        this.scope = "all";
        this.navigate("/");
        break;
      case "resend":
        this.sentTo = "";
        this.render();
        break;
      case "demo":
        this.demoSignIn().catch(() => {});
        break;
      case "solve":
        this.solve().catch(() => {});
        break;
      case "article":
        this.expanded = this.expanded === el.dataset.id ? "" : (el.dataset.id ?? "");
        this.renderAnswers();
        break;
      case "file":
        this.download(el.dataset.id ?? "", el.dataset.name ?? "file").catch(() => {});
        break;
    }
  };

  private onInput = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.name === "q" || (t.name === "subject" && this.route.name === "new")) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      const q = t.value.trim();
      this.searchTimer = setTimeout(() => this.searchAnswers(q).catch(() => {}), 250);
    }
  };

  private onSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const kind = form.dataset.form;
    const field = (name: string) => {
      const v = data.get(name);
      return typeof v === "string" ? v : "";
    };
    if (kind === "login") this.login(field("email"), form).catch(() => {});
    if (kind === "reply") this.reply(field("body"), form).catch(() => {});
    if (kind === "new") this.create(field("subject"), field("body"), form).catch(() => {});
  };

  // ------------------------------------------------------------------ actions

  private setBusy(form: HTMLFormElement | null, busy: boolean, error = "") {
    this.busy = busy;
    form?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = busy));
    const err = form?.querySelector(".err");
    if (err) err.textContent = error;
  }

  private async login(email: string, form: HTMLFormElement) {
    if (this.busy) return;
    if (this.preview) return;
    this.setBusy(form, true);
    try {
      const returnTo = this.getAttribute("return-to") || (this.layout === "page" ? undefined : location.href);
      await this.api.login(email.trim(), returnTo);
      this.sentTo = email.trim();
      this.busy = false;
      this.render();
    } catch (err) {
      this.setBusy(form, false, err instanceof Error ? err.message : "Couldn't send the link");
    }
  }

  private async demoSignIn() {
    const r = await this.api.demo();
    this.adopt(r.token, r.customer, "email");
    this.emit("trace:signin", { customer: r.customer, method: "demo" });
    await this.enter();
  }

  private async reply(body: string, form: HTMLFormElement) {
    const text = body.trim();
    if (!text || this.busy || !this.current) return;
    const number = this.current.ticket.number;
    if (this.preview) {
      this.setBusy(form, false, "This is a preview, so nothing is sent.");
      return;
    }
    this.setBusy(form, true);
    const temp: Message = {
      id: `tmp_${Date.now()}`,
      author: "you",
      authorName: null,
      body: text,
      attachments: [],
      createdAt: new Date().toISOString(),
      pending: true,
    };
    this.current.messages.push(temp);
    this.renderThread();
    try {
      const r = await this.api.reply(number, text);
      if (this.current?.ticket.number === number) {
        this.current.messages = this.current.messages.map((m) => (m.id === temp.id ? r.message : m));
        this.current.ticket = { ...this.current.ticket, ...r.ticket };
      }
      this.fastUntil = Date.now() + 25_000;
      this.busy = false;
      this.render();
      this.schedulePoll();
    } catch (err) {
      if (this.current) this.current.messages = this.current.messages.filter((m) => m.id !== temp.id);
      this.renderThread();
      this.setBusy(form, false, err instanceof Error ? err.message : "Couldn't send your reply");
    }
  }

  private async solve() {
    if (!this.current || this.busy || this.preview) return;
    this.busy = true;
    try {
      const r = await this.api.solve(this.current.ticket.number);
      this.current.ticket = { ...this.current.ticket, ...r.ticket };
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : "Couldn't update the request";
    }
    this.busy = false;
    this.render();
  }

  private async create(subject: string, body: string, form: HTMLFormElement) {
    if (this.busy) return;
    if (!subject.trim() || !body.trim()) {
      this.setBusy(form, false, "Please add a subject and describe what's going on.");
      return;
    }
    if (this.preview) {
      this.setBusy(form, false, "This is a preview, so nothing is sent.");
      return;
    }
    this.setBusy(form, true);
    try {
      const r = await this.api.create(subject.trim(), body.trim());
      this.busy = false;
      this.tickets = null;
      this.emit("trace:ticket-created", { ticket: r.ticket });
      this.navigate(`/tickets/${r.ticket.number}`);
    } catch (err) {
      this.setBusy(form, false, err instanceof Error ? err.message : "Couldn't submit your request");
    }
  }

  private async searchAnswers(q: string) {
    if (!this.s.showKnowledge) return;
    if (q.length < 3) {
      this.answers = [];
      this.answersFor = "";
      this.renderAnswers();
      return;
    }
    if (q === this.answersFor) return;
    this.answersFor = q;
    if (this.preview) {
      this.answers = [
        {
          id: "a1",
          title: "Getting started",
          url: null,
          excerpt: "Everything you need to set up your account and invite your team.",
          body: "Everything you need to set up your account and invite your team.",
        },
      ];
    } else {
      const r = await this.api.search(q).catch(() => ({ articles: [] as Article[] }));
      if (this.answersFor !== q) return;
      this.answers = r.articles;
    }
    this.renderAnswers();
  }

  private async download(id: string, name: string) {
    if (!this.current || this.preview) return;
    const blob = await this.api.attachment(this.current.ticket.number, id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ------------------------------------------------------------------ rendering

  private portalTitle() {
    return this.s.title || `${this.cfg?.org.name ?? ""} support`.trim();
  }

  /** The logo image, or the workspace initials when there is none. */
  private logo() {
    const src = this.s.logoUrl || this.cfg?.org.logo;
    return src ? `<img src="${esc(src)}" alt="">` : esc(initials(this.cfg?.org.name ?? "S"));
  }

  private render() {
    if (!this.cfg) return;
    const signedIn = !!this.token || this.preview;
    const r = this.route;
    let main: string;
    if (r.name === "signin" || !signedIn) {
      // Your platform may handle sign-in itself: cancel this event to keep the form hidden.
      const show = r.name === "signin" || this.emit("trace:unauthenticated", {}, true);
      main = show ? this.signInView() : "";
    } else if (this.scope === "ticket" && r.name !== "ticket") {
      main = this.scopedView();
    } else if (r.name === "ticket") {
      main = this.ticketView();
    } else if (r.name === "new") {
      main = this.newView();
    } else {
      main = this.listView();
    }
    this.root.innerHTML = `${this.hasAttribute("hide-header") ? "" : this.header()}<main part="main">${main}${this.footer()}</main>`;
    if (r.name === "list" || r.name === "new") this.renderAnswers();
  }

  private header() {
    const s = this.s;
    const signedIn = (!!this.token || this.preview) && this.route.name !== "signin";
    const name = this.customer?.name || this.customer?.email || "";
    const me =
      signedIn && this.customer
        ? `<div class="me"><button type="button" data-act="menu" aria-haspopup="menu" aria-expanded="${this.menuOpen}"><span class="av">${esc(initials(name))}</span><span class="nm">${esc(name)}</span></button>${
            this.menuOpen
              ? `<div class="menu" role="menu" part="menu"><div class="who">${esc(this.customer.email ?? name)}</div><button type="button" role="menuitem" data-act="signout">Sign out</button></div>`
              : ""
          }</div>`
        : "";
    const home =
      s.homeUrl && this.layout === "page"
        ? `<a class="homelink" href="${esc(s.homeUrl)}">${esc(this.cfg?.org.name ?? "Home")} ${icons.external()}</a>`
        : "";
    return `<header class="top" part="header"><div class="in"><a class="brand" href="${esc(this.href("/"))}" data-nav="/" part="brand">${this.s.logoUrl || this.cfg?.org.logo ? this.logo() : `<span class="mark">${this.logo()}</span>`}<b>${esc(this.portalTitle())}</b></a><span class="spacer"></span>${home}${me}</div></header>`;
  }

  /** The account menu opens without touching the page below it (a half-written request stays put). */
  private renderHeader() {
    const top = this.root.querySelector("header.top");
    if (top) top.outerHTML = this.header();
    else this.render();
  }

  private footer() {
    return this.s.showPoweredBy
      ? `<div class="foot" part="footer">Powered by <a href="https://github.com/ontrace-dev/trace" target="_blank" rel="noopener">trace</a></div>`
      : "";
  }

  private signInView() {
    const s = this.s;
    const demo = this.cfg?.demo;
    if (this.sentTo) {
      return `<section class="card signin" part="card signin"><span class="sent">${icons.mail()}</span><h1>Check your inbox</h1><p>We sent a sign-in link to <b>${esc(this.sentTo)}</b>. It works once and expires in 30 minutes.</p><button type="button" class="btn" data-act="resend" part="button">Use a different email</button></section>`;
    }
    const form = s.emailSignIn
      ? `<form data-form="login" novalidate><label class="f">Email<input class="input" part="input" type="email" name="email" autocomplete="email" required placeholder="you@company.com"></label><div class="err" role="alert">${esc(this.loadError)}</div><button class="btn primary" type="submit" part="button button-primary">Email me a sign-in link</button></form>`
      : `<p>Sign in on ${esc(this.cfg?.org.name ?? "our")} website to see your requests here.</p>`;
    const demoBtn = demo
      ? `${s.emailSignIn ? `<div class="or">or</div>` : ""}<button type="button" class="btn" data-act="demo" part="button">Continue as demo customer (${esc(demo.customer)})</button>`
      : "";
    return `<section class="card signin" part="card signin"><div class="mark">${this.logo()}</div><h1>${esc(this.portalTitle())}</h1><p>Sign in to see your requests and reply to our team.</p>${form}${demoBtn}</section>`;
  }

  private scopedView() {
    return `<section class="card banner" part="banner"><span>You opened a single request from an email link. Sign in to see all your requests.</span><button type="button" class="btn sm primary" data-act="signin" part="button button-primary">Sign in</button></section>`;
  }

  private searchBox(placeholder = "Search for answers…") {
    if (!this.s.showKnowledge) return "";
    return `<div class="search" part="search">${icons.search()}<label class="sr" for="q">Search</label><input id="q" class="input" part="input" name="q" type="search" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(this.answersFor)}"><div data-slot="answers"></div></div>`;
  }

  private renderAnswers() {
    const slot = this.root.querySelector<HTMLElement>('[data-slot="answers"]');
    if (!slot) return;
    if (!this.answers.length) {
      slot.innerHTML =
        this.answersFor && this.route.name === "list"
          ? `<div class="card answers"><div class="empty" style="padding:18px">No articles match “${esc(this.answersFor)}”.</div></div>`
          : "";
      return;
    }
    const rows = this.answers
      .map((a) =>
        a.url
          ? `<a class="answer" href="${esc(a.url)}" target="_blank" rel="noopener" part="answer"><b>${esc(a.title)} ${icons.external()}</b><span>${esc(a.excerpt)}</span></a>`
          : `<button type="button" class="answer" data-act="article" data-id="${esc(a.id)}" aria-expanded="${this.expanded === a.id}" part="answer"><b>${esc(a.title)}</b>${
              this.expanded === a.id ? "" : `<span>${esc(a.excerpt)}</span>`
            }</button>${this.expanded === a.id ? `<div class="article body" part="article">${markdown(a.body ?? a.excerpt)}</div>` : ""}`,
      )
      .join("");
    const hd = this.route.name === "new" ? "These articles might answer it" : "Articles";
    slot.innerHTML = `<div class="card answers" part="answers"><div class="hd">${hd}</div>${rows}</div>`;
  }

  private listView() {
    const s = this.s;
    const c = this.counts;
    const n = (k: keyof Counts) => (c ? `<span class="n${k === "awaiting_you" ? " hot" : ""}">${c[k]}</span>` : "");
    const activeN = c ? c.open + c.awaiting_you : 0;
    const tabs = (
      [
        ["active", "Open", c ? `<span class="n${c.awaiting_you ? " hot" : ""}">${activeN}</span>` : ""],
        ["solved", "Solved", n("solved")],
        ["all", "All", n("all")],
      ] as const
    )
      .map(
        ([k, label, count]) =>
          `<button type="button" class="tab" role="tab" data-tab="${k}" aria-selected="${this.tab === k}" part="tab">${label}${count}</button>`,
      )
      .join("");
    const list = this.preview
      ? (this.tickets ?? []).filter((t) =>
          this.tab === "all" ? true : this.tab === "solved" ? t.state === "solved" : t.state !== "solved",
        )
      : this.tickets;
    let body: string;
    if (this.loadError) body = `<div class="empty"><b>Something went wrong</b>${esc(this.loadError)}</div>`;
    else if (!list) body = `<div class="loading"><span class="spin" aria-label="Loading"></span></div>`;
    else if (!list.length) {
      const msg =
        this.tab === "solved"
          ? ["No solved requests yet", "Requests we've resolved will show up here."]
          : this.tab === "active"
            ? ["No open requests", "Everything's taken care of."]
            : ["No requests yet", "When you contact us, by email, chat or here, your requests show up here."];
      body = `<div class="empty"><b>${msg[0]}</b>${msg[1]}${
        s.allowNewRequests && this.tab !== "solved"
          ? `<div><button type="button" class="btn primary" data-nav="/new" part="button button-primary">${icons.plus()} New request</button></div>`
          : ""
      }</div>`;
    } else body = list.map((t) => this.rowHtml(t)).join("");
    return `<div class="hero"><div><h1 part="title">Your requests</h1>${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ""}</div>${
      s.allowNewRequests
        ? `<button type="button" class="btn primary" data-nav="/new" part="button button-primary">${icons.plus()} New request</button>`
        : ""
    }</div>${this.searchBox()}<div class="tabs" role="tablist" part="tabs">${tabs}</div><div class="card list" part="ticket-list">${body}</div>`;
  }

  private rowHtml(t: Ticket) {
    const who = t.lastAuthor === "you" ? "You" : t.lastAuthor === "ai" || t.lastAuthor === "team" ? "Support" : "";
    return `<a class="row${t.state === "awaiting_you" ? " you" : ""}" href="${esc(this.href(`/tickets/${t.number}`))}" data-nav="/tickets/${t.number}" part="ticket-row"><span class="s">${esc(t.subject)}</span><span class="m">${esc(t.ref)}${
      t.preview ? ` · ${who ? `${who}: ` : ""}${esc(t.preview)}` : ""
    }</span><span class="r"><span class="pill ${t.state}" part="status">${STATE_LABEL[t.state]}</span><span class="t">${esc(timeLabel(t.updatedAt))}</span></span></a>`;
  }

  private ticketView() {
    const back =
      this.scope === "all"
        ? `<button type="button" class="back" data-nav="/" part="back">${icons.back()} All requests</button>`
        : this.scopedView();
    if (!this.current) {
      return `${back}${this.loadError ? `<div class="card empty"><b>Couldn't open this request</b>${esc(this.loadError)}</div>` : `<div class="loading"><span class="spin" aria-label="Loading"></span></div>`}`;
    }
    const t = this.current.ticket;
    return `${back}<div class="thead"><h1 part="title">${esc(t.subject)}</h1><span class="pill ${t.state}" part="status" data-slot="status">${STATE_LABEL[t.state]}</span></div><div class="meta"><span>${esc(t.ref)}</span><span class="dotsep">Opened ${esc(fmtDate(t.createdAt))}</span><span class="dotsep">via ${esc(CHANNELS[t.channel] ?? t.channel)}</span></div><div class="thread" part="thread" data-slot="thread">${this.threadHtml()}</div>${this.composerHtml()}`;
  }

  private threadHtml() {
    if (!this.current) return "";
    const t = this.current.ticket;
    const msgs = this.current.messages.map((m) => this.messageHtml(m)).join("");
    const working = t.working
      ? `<div class="working" part="working"><i></i><i></i><i></i> ${esc(this.cfg?.org.name ?? "Support")} is looking into it…</div>`
      : "";
    return `${msgs}${working}`;
  }

  private messageHtml(m: Message) {
    const org = this.cfg?.org.name ?? "Support";
    const name =
      m.author === "you"
        ? "You"
        : m.author === "ai"
          ? m.authorName || `${org} assistant`
          : m.author === "team"
            ? m.authorName || org
            : org;
    const av =
      m.author === "ai"
        ? icons.sparkle()
        : m.author === "you"
          ? esc(initials(this.customer?.name || this.customer?.email || "You"))
          : esc(initials(name));
    const files = m.attachments.length
      ? `<div class="files">${m.attachments
          .map(
            (a) =>
              `<button type="button" class="file" data-act="file" data-id="${esc(a.id)}" data-name="${esc(a.name)}" part="attachment">${icons.clip()} ${esc(a.name)}</button>`,
          )
          .join("")}</div>`
      : "";
    return `<article class="card msg ${m.author}${m.pending ? " pending" : ""}" part="message message-${m.author}"><div class="h"><span class="av">${av}</span><b>${esc(name)}</b>${
      m.author === "ai" ? `<span class="tag">AI</span>` : ""
    }<span>${m.pending ? "Sending…" : esc(fmtDateTime(m.createdAt))}</span></div><div class="body" part="message-body">${markdown(m.body)}</div>${files}</article>`;
  }

  private composerHtml() {
    const t = this.current?.ticket;
    if (!t) return "";
    const solved = t.state === "solved";
    return `${solved ? `<div class="solved-note" part="solved">${icons.check()} This request is solved. Reply below if you need anything else; it reopens the request.</div>` : ""}<form class="card composer" data-form="reply" part="composer"><label class="sr" for="reply">Reply</label><textarea id="reply" class="textarea" part="input" name="body" placeholder="${solved ? "Write a reply to reopen this request…" : "Write a reply…"}"></textarea><div class="err" role="alert"></div><div class="actions"><span class="note">${
      t.state === "awaiting_you" ? "We're waiting for your reply." : ""
    }</span><span style="display:flex;gap:8px">${
      solved ? "" : `<button type="button" class="btn sm" data-act="solve" part="button">Mark as solved</button>`
    }<button class="btn sm primary" type="submit" part="button button-primary">Send reply</button></span></div></form>`;
  }

  /** Update the thread and status in place, leaving a half-written reply alone. */
  private renderThread() {
    const thread = this.root.querySelector<HTMLElement>('[data-slot="thread"]');
    if (!thread || !this.current) {
      this.render();
      return;
    }
    const status = this.root.querySelector<HTMLElement>('[data-slot="status"]');
    const t = this.current.ticket;
    const wasSolved = status?.classList.contains("solved");
    if (wasSolved !== (t.state === "solved")) {
      // The composer copy depends on it: re-render, but keep what was typed.
      const draft = this.root.querySelector<HTMLTextAreaElement>("textarea[name=body]")?.value ?? "";
      this.render();
      const ta = this.root.querySelector<HTMLTextAreaElement>("textarea[name=body]");
      if (ta) ta.value = draft;
      return;
    }
    if (status) {
      status.className = `pill ${t.state}`;
      status.textContent = STATE_LABEL[t.state];
    }
    thread.innerHTML = this.threadHtml();
  }

  private newView() {
    return `<button type="button" class="back" data-nav="/" part="back">${icons.back()} All requests</button><div class="hero"><div><h1 part="title">New request</h1><p class="intro">Tell us what's going on. We'll reply here${
      this.customer?.email ? " and by email" : ""
    }.</p></div></div><form class="card form" data-form="new" part="card form" novalidate><label class="f">Subject<input class="input" part="input" name="subject" maxlength="200" autocomplete="off" required placeholder="A short summary"></label><div data-slot="answers"></div><label class="f">Description <span class="h">Steps, links and error messages help us answer faster.</span><textarea class="textarea" part="input" name="body" rows="7" required></textarea></label><div class="err" role="alert"></div><div class="actions"><button type="button" class="btn" data-nav="/" part="button">Cancel</button><button class="btn primary" type="submit" part="button button-primary">Submit request</button></div></form>`;
  }
}

// -------------------------------------------------------------------- storage helpers

function sessionGet(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage disabled — the link still works for this page view */
  }
}

// -------------------------------------------------------------------- global entry

export interface MountOptions {
  workspace: string;
  /** trace server origin; defaults to where portal.js was loaded from. */
  server?: string;
  layout?: "page" | "embed";
  routing?: Routing;
  basePath?: string;
  theme?: "light" | "dark" | "auto";
  accent?: string;
  radius?: number;
  font?: string;
  hideHeader?: boolean;
  /** Where email sign-in links come back to (must be on a site listed under allowed sites). */
  returnTo?: string;
  identity?: Identity;
  settings?: Partial<PortalSettings>;
}

function mount(target: string | Element, opts: MountOptions) {
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) throw new Error(`[trace] portal target ${typeof target === "string" ? target : "element"} not found`);
  const el = document.createElement("trace-portal") as TracePortalElement;
  const set = (k: string, v: string | number | boolean | undefined) => {
    if (v === undefined || v === false) return;
    el.setAttribute(k, v === true ? "" : String(v));
  };
  set("workspace", opts.workspace);
  set("server", opts.server);
  set("layout", opts.layout);
  set("routing", opts.routing);
  set("base-path", opts.basePath);
  set("theme", opts.theme);
  set("accent", opts.accent);
  set("radius", opts.radius);
  set("font", opts.font);
  set("hide-header", opts.hideHeader);
  set("return-to", opts.returnTo);
  if (opts.identity) el.identify(opts.identity).catch(() => {});
  if (opts.settings) el.update(opts.settings);
  host.appendChild(el);
  return el;
}

if (!customElements.get("trace-portal")) customElements.define("trace-portal", TracePortalElement);

const w = window as unknown as { TracePortal?: { mount: typeof mount } };
w.TracePortal = { mount };

// <script src=".../portal.js" data-workspace="acme" data-target="#support"> mounts without any JavaScript.
if (scriptEl?.dataset.workspace) {
  const go = () =>
    mount(scriptEl.dataset.target || document.body, {
      workspace: scriptEl.dataset.workspace!,
      layout: scriptEl.dataset.layout === "page" ? "page" : undefined,
      routing: (scriptEl.dataset.routing as Routing | undefined) ?? undefined,
      theme: (scriptEl.dataset.theme as MountOptions["theme"]) ?? undefined,
      accent: scriptEl.dataset.accent,
    });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });
  else go();
}
