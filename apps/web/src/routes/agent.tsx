import { Navigate, useParams } from "@tanstack/react-router";
import { BookOpen, Bot, FlaskConical, Workflow } from "lucide-react";
import * as React from "react";
import { KnowledgePage } from "./knowledge";
import { SubNavLayout, type SubNavItem } from "./settings";
import { ActionsSettings } from "./settings/actions";
import { AiSettingsPage } from "./settings/ai";
import { TestingPage } from "./settings/testing";
import { useWorkspace } from "@/lib/workspace";

/** Everything that shapes the AI agent: its setup, what it knows, what it may do, and a place to try it. */
const pages = [
  { id: "ai", label: "Setup", icon: Bot, el: AiSettingsPage },
  { id: "knowledge", label: "Knowledge", icon: BookOpen, el: KnowledgePage },
  { id: "actions", label: "Actions & procedures", icon: Workflow, el: ActionsSettings },
  { id: "testing", label: "Test & simulate", icon: FlaskConical, el: TestingPage },
];

function AgentLayout({ current, children }: { current: string; children: React.ReactNode }) {
  const { slug } = useWorkspace();
  return (
    <SubNavLayout
      title="Agent"
      items={pages.map((p): SubNavItem => {
        const item = { id: p.id, label: p.label, icon: p.icon, active: p.id === current };
        // Knowledge keeps its own URLs, so article links stay put.
        return p.id === "knowledge"
          ? { ...item, to: "/w/$slug/knowledge", params: { slug } }
          : { ...item, to: "/w/$slug/agent/$section", params: { slug, section: p.id } };
      })}
    >
      {children}
    </SubNavLayout>
  );
}

export function AgentPage() {
  const { section } = useParams({ from: "/w/$slug/agent/$section" });
  const { slug } = useWorkspace();
  if (section === "knowledge") return <Navigate to="/w/$slug/knowledge" params={{ slug }} replace />;
  const page = pages.find((p) => p.id === section) ?? pages[0]!;
  const El = page.el;
  return (
    <AgentLayout current={page.id}>
      <El />
    </AgentLayout>
  );
}

export function AgentKnowledgePage() {
  return (
    <AgentLayout current="knowledge">
      <KnowledgePage />
    </AgentLayout>
  );
}
