import * as React from "react";
import { SettingsHeader } from "../settings";
import { Segmented } from "@/components/ui";
import { Playground } from "@/features/testing/playground";
import { Suite } from "@/features/testing/suite";

/** Simulation playground + test suite: see what the agent would do before it reaches a customer. */
export function TestingPage() {
  const [tab, setTab] = React.useState<"playground" | "suite">(() => {
    try {
      return (localStorage.getItem("trace:testing-tab") as "playground" | "suite") || "playground";
    } catch {
      return "playground";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem("trace:testing-tab", tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  return (
    <div className="flex min-h-full flex-col">
      <SettingsHeader
        title="Test & simulate"
        description="Run the real agent — same prompt, knowledge, procedures and policy — on any message before customers see it. Tests never send messages, create tickets or run write actions; only read-only actions execute."
      >
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "playground", label: "Playground" },
            { value: "suite", label: "Test suite" },
          ]}
        />
      </SettingsHeader>
      {tab === "playground" ? <Playground /> : <Suite />}
    </div>
  );
}
