export interface WidgetSettings {
  title: string;
  subtitle: string;
  greeting: string;
  agentName: string;
  avatarUrl: string;
  accentColor: string;
  accentForeground: string;
  theme: "light" | "dark" | "auto";
  position: "right" | "left";
  offsetX: number;
  offsetY: number;
  radius: number;
  fontFamily: string;
  launcherIcon: "chat" | "help" | "sparkle" | "wave";
  launcherText: string;
  suggestions: string[];
  requireEmail: boolean;
  showPoweredBy: boolean;
  aiInstantAnswers: boolean;
  allowedOrigins: string[];
  customCss: string;
}

export interface Runtime {
  /** Hide the default launcher (for custom launchers via data-trace-open / Trace('open')). */
  hideLauncher?: boolean;
  /** Never switch to the full-screen mobile layout (used by the settings preview). */
  noFullscreen?: boolean;
}

export interface WidgetConfig {
  widget: WidgetSettings;
  org: { name: string; logo: string | null };
  ai: { agentName: string; enabled: boolean; online: boolean };
}

export interface Conversation {
  id: string;
  subject: string;
  status: "open" | "pending" | "resolved" | "closed";
  aiState: string;
  createdAt: string;
  lastMessageAt: string;
  preview?: string;
  lastAuthorType?: string | null;
  lastAuthorName?: string | null;
  unread?: boolean;
}

export interface WMessage {
  id: string;
  ticketId: string;
  authorType: "customer" | "agent" | "ai" | "system";
  authorName: string | null;
  body: string;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

export interface Identity {
  email?: string;
  name?: string;
  userId?: string;
  userHash?: string;
  attributes?: Record<string, unknown>;
}
