import { AlertDialog as AD } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./index";

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Label of the confirming button — be specific ("Revoke", "Remove"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<Confirm | null>(null);

/**
 * App-wide confirmation dialog (Radix AlertDialog — the primitive shadcn's Alert Dialog uses).
 * Focus starts on Cancel, Escape cancels, and screen readers announce it as an alert.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Revoke API key?", confirmLabel: "Revoke", destructive: true })) revoke();
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = React.useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setState({ ...options, resolve });
      }),
    [],
  );
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AD.Root open={!!state} onOpenChange={(open) => !open && close(false)}>
        <AD.Portal>
          <AD.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
          <AD.Content className="fixed top-[22vh] left-1/2 z-50 flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 flex-col border border-line-strong bg-bar shadow-2xl shadow-black/60 focus:outline-none">
            <div className="flex flex-col gap-2 px-5 pt-5 pb-4">
              <AD.Title className="text-[14px] font-semibold tracking-tight text-fg">{state?.title}</AD.Title>
              <AD.Description
                className={cn("text-[12.5px] leading-relaxed text-muted", !state?.description && "sr-only")}
              >
                {state?.description ?? state?.title}
              </AD.Description>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <AD.Cancel asChild>
                <Button variant="ghost">{state?.cancelLabel ?? "Cancel"}</Button>
              </AD.Cancel>
              <AD.Action asChild>
                <Button
                  variant={state?.destructive ? "danger" : "primary"}
                  className={
                    state?.destructive ? "border-red-400/50 bg-red-500/15 text-red-200 hover:bg-red-500/25" : undefined
                  }
                  onClick={() => close(true)}
                >
                  {state?.confirmLabel ?? "Confirm"}
                </Button>
              </AD.Action>
            </div>
          </AD.Content>
        </AD.Portal>
      </AD.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
