import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Message, Ticket, TicketDetail } from "@/lib/types";
import { qk, useWorkspace } from "@/lib/workspace";

export function useTicket(ref: string) {
  const { api, wid } = useWorkspace();
  return useQuery({
    queryKey: qk.ticket(wid, ref),
    queryFn: () => api<TicketDetail>(`/tickets/${ref}`),
  });
}

/** Mutations on a ticket; every success refreshes the ticket, the lists and the counts. */
export function useTicketActions(ticketId: string | undefined) {
  const { api, wid } = useWorkspace();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ticket", wid] });
    qc.invalidateQueries({ queryKey: ["tickets", wid] });
    qc.invalidateQueries({ queryKey: qk.counts(wid) });
  };
  const onError = (e: unknown) => toast.error((e as Error).message);

  const update = useMutation({
    mutationFn: (patch: Partial<Pick<Ticket, "status" | "priority" | "assigneeId" | "tags" | "subject">>) =>
      api<{ ticket: Ticket }>(`/tickets/${ticketId}`, { method: "PATCH", json: patch }),
    onSuccess: refresh,
    onError,
  });
  const reply = useMutation({
    mutationFn: (b: {
      body: string;
      kind: "message" | "note";
      attachments?: Message["attachments"];
      status?: Ticket["status"];
    }) => api<{ message: Message }>(`/tickets/${ticketId}/messages`, { method: "POST", json: b }),
    onSuccess: refresh,
    onError,
  });
  const sendDraft = useMutation({
    mutationFn: (body?: string) => api(`/tickets/${ticketId}/draft/send`, { method: "POST", json: { body } }),
    onSuccess: () => {
      toast.success("Reply sent");
      refresh();
    },
    onError,
  });
  const discardDraft = useMutation({
    mutationFn: () => api(`/tickets/${ticketId}/draft/discard`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });
  const runAi = useMutation({
    mutationFn: () => api(`/tickets/${ticketId}/ai/run`, { method: "POST" }),
    onSuccess: () => {
      toast("Agent is re-reading the conversation…");
      refresh();
    },
    onError,
  });
  const summarize = useMutation({
    mutationFn: () =>
      api<{ summary: string; offline: boolean }>(`/tickets/${ticketId}/ai/summarize`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });
  const toArticle = useMutation({
    mutationFn: () => api<{ article: { id: string } }>(`/tickets/${ticketId}/ai/article`, { method: "POST" }),
    onError,
  });
  return { update, reply, sendDraft, discardDraft, runAi, summarize, toArticle, refresh };
}
