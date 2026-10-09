import { decrypt } from "../../../lib/crypto.ts";
import type { KnowledgeSourceConfig } from "../../../lib/types.ts";
import { fetchConfluence, fetchJira } from "./atlassian.ts";
import { fetchNotion } from "./notion.ts";
import { ConnectorError, type ConnectorRun } from "./util.ts";
import { crawlWebsite } from "./website.ts";
import { fetchZendesk } from "./zendesk.ts";

export { ConnectorError } from "./util.ts";
export type { ConnectorDoc } from "./util.ts";

/** Start a connector run for a source config. `max` caps documents (used by connection tests). */
export function runConnector(
  config: KnowledgeSourceConfig,
  encryptedSecret: string | null,
  opts: { max?: number } = {},
): ConnectorRun {
  const token = encryptedSecret ? decrypt(encryptedSecret) : "";
  switch (config.type) {
    case "website":
      return crawlWebsite(opts.max ? { ...config, maxPages: Math.min(config.maxPages || 50, opts.max) } : config);
    case "confluence":
      return fetchConfluence(config, token, opts);
    case "jira":
      return fetchJira(config, token, opts);
    case "notion":
      return fetchNotion(config, token, opts);
    case "zendesk":
      return fetchZendesk(config, token, opts);
    case "files":
      return (async function* () {
        // Files are uploaded, not synced.
      })();
    default:
      throw new ConnectorError(`Unknown source type`);
  }
}
