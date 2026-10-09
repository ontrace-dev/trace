import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { HomePage } from "./features/home/home";
import { AgentKnowledgePage, AgentPage } from "./routes/agent";
import { HomeRedirect, InvitePage, LoginPage, OnboardingPage, SignupPage } from "./routes/auth";
import { CustomerDetail, CustomersPage } from "./routes/customers";
import { InboxEmpty, InboxPage } from "./routes/inbox";
import { InsightsPage } from "./routes/insights";
import { ArticleEditor } from "./routes/knowledge";
import { SettingsPage } from "./routes/settings";
import { TicketPane } from "./routes/ticket";
import { ViewsPage } from "./routes/views";
import { WorkspaceLayout } from "./routes/workspace-layout";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRedirect });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/signup", component: SignupPage });
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/$id", component: InvitePage });

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$slug",
  component: WorkspaceLayout,
});
const wsIndexRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "/", component: HomePage });
export const viewsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "views", component: ViewsPage });
export const inboxRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "inbox/$view",
  component: InboxPage,
});
const inboxIndexRoute = createRoute({ getParentRoute: () => inboxRoute, path: "/", component: InboxEmpty });
export const ticketRoute = createRoute({ getParentRoute: () => inboxRoute, path: "$ticket", component: TicketPane });
export const customersRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "customers",
  component: CustomersPage,
});
export const customerRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "customers/$customerId",
  component: CustomerDetail,
});
export const knowledgeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "knowledge",
  component: AgentKnowledgePage,
});
export const articleRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "knowledge/$articleId",
  component: ArticleEditor,
});
export const agentRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "agent/$section",
  component: AgentPage,
});
const insightsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: "insights", component: InsightsPage });
export const settingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "settings/$section",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  onboardingRoute,
  inviteRoute,
  workspaceRoute.addChildren([
    wsIndexRoute,
    viewsRoute,
    inboxRoute.addChildren([inboxIndexRoute, ticketRoute]),
    customersRoute,
    customerRoute,
    knowledgeRoute,
    articleRoute,
    agentRoute,
    insightsRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
