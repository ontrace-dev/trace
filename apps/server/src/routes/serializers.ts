import type { WidgetSettings, AiSettings } from "../lib/types.ts";
import type { workspaceSettings } from "../db/schema.ts";

/** Never send secrets back to the browser in full. */
export function publicSettings(s: typeof workspaceSettings.$inferSelect) {
  const ai: AiSettings & { hasApiKey: boolean } = { ...s.ai, apiKey: undefined, hasApiKey: !!s.ai.apiKey };
  return { ...s, ai };
}

export function mask(secret?: string | null) {
  if (!secret) return "";
  return secret.length <= 8 ? "••••" : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

export function widgetForBrowser(w: WidgetSettings) {
  const { identitySecret: _s, ...rest } = w;
  return rest;
}
