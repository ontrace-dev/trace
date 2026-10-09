import type { IssueStatusCategory } from "../../db/schema.ts";
import { decrypt } from "../../lib/crypto.ts";
import type { JiraConfig, LinearConfig } from "../../lib/types.ts";

/**
 * Minimal clients for the issue trackers trace files into. Both expose the same shape so the UI and the
 * sync don't care which one a ticket is linked to.
 */

export interface Issue {
  externalId: string;
  key: string;
  url: string;
  title: string;
  status: string;
  statusCategory: IssueStatusCategory;
}

export interface Container {
  id: string;
  key: string;
  name: string;
}

export interface CreateInput {
  container: string;
  title: string;
  /** Markdown. */
  description: string;
  /** Classification value (bug, feature request, …), mapped to a label / issue type. */
  type: string | null;
}

export interface Tracker {
  verify(): Promise<{ name: string }>;
  containers(): Promise<Container[]>;
  /** Labels (Linear) or issue types (Jira) available in a team/project, for the type mapping. */
  kinds(container: string): Promise<{ id: string; name: string }[]>;
  create(input: CreateInput): Promise<Issue>;
  get(key: string): Promise<Issue>;
  search(text: string, container?: string): Promise<Issue[]>;
  /** Put a link back to the trace ticket on the issue. Best effort. */
  linkBack(issue: Issue, url: string, title: string): Promise<void>;
}

class TrackerError extends Error {}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { errors?: unknown; errorMessages?: string[]; message?: string };
      detail = j.errorMessages?.join("; ") || j.message || (j.errors ? JSON.stringify(j.errors).slice(0, 300) : detail);
    } catch {
      /* not json */
    }
    throw new TrackerError(
      res.status === 401 || res.status === 403
        ? `${what}: the credentials were rejected (${res.status})`
        : `${what} failed (${res.status}): ${detail}`,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------- Linear

const LINEAR_URL = process.env.LINEAR_API_URL || "https://api.linear.app/graphql";

type LinearIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state?: { name: string; type: string };
};

const linearCategory = (type?: string): IssueStatusCategory =>
  type === "completed" ? "done" : type === "canceled" ? "canceled" : type === "started" ? "started" : "todo";

const fromLinear = (i: LinearIssue): Issue => ({
  externalId: i.id,
  key: i.identifier,
  url: i.url,
  title: i.title,
  status: i.state?.name ?? "",
  statusCategory: linearCategory(i.state?.type),
});

const ISSUE_FIELDS = "id identifier url title state { name type }";

export function linearClient(cfg: LinearConfig): Tracker {
  const key = decrypt(cfg.apiKey);
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(LINEAR_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await json<{ data?: T; errors?: { message: string }[] }>(res, "Linear");
    if (body.errors?.length) throw new TrackerError(`Linear: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  };
  return {
    async verify() {
      const d = await gql<{ viewer: { name: string }; organization: { name: string } }>(
        "query { viewer { name } organization { name } }",
      );
      return { name: d.organization?.name ?? d.viewer.name };
    },
    async containers() {
      const d = await gql<{ teams: { nodes: Container[] } }>("query { teams(first: 100) { nodes { id key name } } }");
      return d.teams.nodes;
    },
    async kinds(teamId) {
      const d = await gql<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
        "query($id: String!) { team(id: $id) { labels(first: 100) { nodes { id name } } } }",
        { id: teamId },
      );
      return d.team?.labels.nodes ?? [];
    },
    async create(input) {
      let labelIds: string[] = [];
      if (input.type) {
        const mapped = cfg.typeLabels?.[input.type];
        if (mapped) labelIds = [mapped];
        else {
          // No mapping configured: use a team label with the same name ("Bug", "Feature request"), if any.
          const labels = await this.kinds(input.container).catch(() => []);
          const want = input.type.toLowerCase().replace(/\s+/g, " ");
          const hit = labels.find((l) => {
            const n = l.name.toLowerCase();
            return n === want || (want === "feature request" && (n === "feature" || n === "feature-request"));
          });
          if (hit) labelIds = [hit.id];
        }
      }
      const d = await gql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        { input: { teamId: input.container, title: input.title, description: input.description, labelIds } },
      );
      if (!d.issueCreate.success) throw new TrackerError("Linear did not create the issue");
      return fromLinear(d.issueCreate.issue);
    },
    async get(k) {
      const d = await gql<{ issue: LinearIssue | null }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
        id: k,
      });
      if (!d.issue) throw new TrackerError(`Linear issue ${k} not found`);
      return fromLinear(d.issue);
    },
    async search(text) {
      const d = await gql<{ searchIssues: { nodes: LinearIssue[] } }>(
        `query($t: String!) { searchIssues(term: $t, first: 5) { nodes { ${ISSUE_FIELDS} } } }`,
        { t: text.slice(0, 120) },
      );
      return d.searchIssues.nodes.map(fromLinear);
    },
    async linkBack(issue, url, title) {
      await gql("mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }", {
        input: { issueId: issue.externalId, url, title, subtitle: "Support ticket in trace" },
      }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- Jira

/** "acme", "acme.atlassian.net" or a full URL → https://acme.atlassian.net */
export function jiraBase(site: string) {
  const s = site.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.includes(".") ? s : `${s}.atlassian.net`}`;
}

type JiraIssue = {
  id: string;
  key: string;
  fields: { summary: string; status?: { name: string; statusCategory?: { key: string } } };
};

const jiraCategory = (k?: string): IssueStatusCategory =>
  k === "done" ? "done" : k === "indeterminate" ? "started" : "todo";

/** Markdown → Atlassian Document Format (headings, lists, paragraphs, inline code kept as text). */
export function toAdf(md: string) {
  const content: unknown[] = [];
  let list: { type: string; content: unknown[] } | null = null;
  const text = (t: string) => (t ? [{ type: "text", text: t }] : []);
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (ordered || bullet) {
      const type = ordered ? "orderedList" : "bulletList";
      if (!list || list.type !== type) {
        list = { type, content: [] };
        content.push(list);
      }
      list.content.push({
        type: "listItem",
        content: [{ type: "paragraph", content: text((ordered ?? bullet)![1]!) }],
      });
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (heading)
      content.push({
        type: "heading",
        attrs: { level: Math.min(3, heading[1]!.length + 1) },
        content: text(heading[2]!),
      });
    else content.push({ type: "paragraph", content: text(line) });
  }
  return { type: "doc", version: 1, content };
}

export function jiraClient(cfg: JiraConfig): Tracker {
  const base = jiraBase(cfg.site);
  const auth = `Basic ${Buffer.from(`${cfg.email}:${decrypt(cfg.apiToken)}`).toString("base64")}`;
  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: auth, accept: "application/json", "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    return json<T>(res, "Jira");
  };
  const toIssue = (i: JiraIssue): Issue => ({
    externalId: i.id,
    key: i.key,
    url: `${base}/browse/${i.key}`,
    title: i.fields.summary,
    status: i.fields.status?.name ?? "",
    statusCategory: jiraCategory(i.fields.status?.statusCategory?.key),
  });
  return {
    async verify() {
      const me = await call<{ displayName: string }>("/rest/api/3/myself");
      const info = await call<{ serverTitle?: string }>("/rest/api/3/serverInfo").catch(() => ({
        serverTitle: undefined,
      }));
      return { name: info.serverTitle || new URL(base).hostname || me.displayName };
    },
    async containers() {
      const d = await call<{ values: { id: string; key: string; name: string }[] }>(
        "/rest/api/3/project/search?maxResults=100",
      );
      return d.values.map((p) => ({ id: p.key, key: p.key, name: p.name }));
    },
    async kinds(projectKey) {
      const d = await call<{ issueTypes?: { id: string; name: string }[]; values?: { id: string; name: string }[] }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      );
      return (d.issueTypes ?? d.values ?? []).map((t) => ({ id: t.id, name: t.name }));
    },
    async create(input) {
      const fallback = input.type === "feature request" ? "Story" : input.type === "bug" ? "Bug" : "Task";
      const typeName = (input.type && cfg.typeIssueTypes?.[input.type]) || fallback;
      const types = await this.kinds(input.container).catch(() => []);
      const issuetype =
        types.find((t) => t.name.toLowerCase() === typeName.toLowerCase()) ??
        types.find((t) => t.name.toLowerCase() === "task") ??
        types[0];
      const created = await call<{ id: string; key: string }>("/rest/api/3/issue", {
        method: "POST",
        body: {
          fields: {
            project: { key: input.container },
            summary: input.title.slice(0, 250),
            issuetype: issuetype ? { id: issuetype.id } : { name: typeName },
            description: toAdf(input.description),
            labels: ["trace"],
          },
        },
      });
      return this.get(created.key);
    },
    async get(k) {
      return toIssue(await call<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(k)}?fields=summary,status`));
    },
    async search(text, projectKey) {
      const words = text
        .replace(/["\\]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 8)
        .join(" ");
      if (!words) return [];
      const jql = `${projectKey ? `project = "${projectKey}" AND ` : ""}text ~ "${words}" ORDER BY updated DESC`;
      const d = await call<{ issues: JiraIssue[] }>("/rest/api/3/search/jql", {
        method: "POST",
        body: { jql, maxResults: 5, fields: ["summary", "status"] },
      });
      return d.issues.map(toIssue);
    },
    async linkBack(issue, url, title) {
      await call(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/remotelink`, {
        method: "POST",
        body: { object: { url, title, icon: { title: "trace" } } },
      }).catch(() => {});
    },
  };
}

export function trackerFor(config: LinearConfig | JiraConfig): Tracker {
  return config.kind === "linear" ? linearClient(config) : jiraClient(config);
}

export { TrackerError };
