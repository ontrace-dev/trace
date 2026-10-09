import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Menu, MenuContent, MenuItem, MenuTrigger, Spinner, Tip } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm";
import { QueueTable, type Sort } from "@/features/home/queue-table";
import { homeKeys, type QueueRow } from "@/features/home/types";
import { ViewDialog } from "@/features/view-dialog";
import { qk, useWorkspace } from "@/lib/workspace";

const SORT_NOTES: Record<string, string> = {
  name: "by name",
  total: "by open tickets",
  waiting: "by customers waiting",
  unassigned: "by unassigned",
  urgent: "by high priority",
  sla: "by SLA, most late first",
  drafts: "by AI drafts",
  oldest: "by longest wait",
};

/** Designed in pen.dev ("trace — Views (app)"): every queue in one table, built-in and saved as groups. */
export function ViewsPage() {
  const { api, wid, boot } = useWorkspace();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<Sort>({ key: "sla", dir: -1 });
  const q = useQuery({
    queryKey: homeKeys.views(wid),
    queryFn: () => api<{ queues: QueueRow[] }>("/views/overview"),
    refetchInterval: 30_000,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/views/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.boot(wid) });
      qc.invalidateQueries({ queryKey: homeKeys.views(wid) });
      qc.invalidateQueries({ queryKey: homeKeys.home(wid) });
      toast.success("View deleted");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const queues = q.data?.queues ?? [];
  const editingView = boot.views.find((v) => v.id === editing);
  const remove = async (v: QueueRow) =>
    (await confirm({
      title: `Delete “${v.name}”?`,
      description: "The view disappears for everyone. Tickets aren't affected.",
      confirmLabel: "Delete",
      destructive: true,
    })) && del.mutate(v.id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line pr-6 pl-10">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[#e8e8ef]">Views</span>
          <span className="font-mono text-[11px] text-dim">{queues.length || ""}</span>
        </span>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 bg-fg px-2.5 py-1.5 text-[12.5px] font-medium text-[#080808] hover:bg-white"
        >
          <Plus className="size-[13px]" /> New view
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 py-6 pr-8 pl-10">
          <p className="text-[12.5px] text-body">
            Every queue with its live numbers. Sort to find where help is needed; click a view to work it.
          </p>
          <span className="font-mono text-[11px] text-dim">
            {sort
              ? `sorted ${SORT_NOTES[sort.key]}${sort.dir === 1 && sort.key !== "name" ? ", ascending" : ""}`
              : "in sidebar order"}
          </span>
        </div>
        {q.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : (
          <QueueTable
            variant="views"
            sort={sort}
            onSort={setSort}
            groups={[
              { label: "Built-in", queues: queues.filter((v) => v.system) },
              {
                label: "Saved",
                note: queues.some((v) => !v.system)
                  ? `shared with everyone in ${boot.org.slug}`
                  : "none yet — save a filter like “urgent billing” to get a queue for it",
                queues: queues.filter((v) => !v.system),
                actions: (v) => (
                  <span className="inline-flex items-center gap-1 text-dim">
                    <Tip label="Edit view">
                      <button
                        aria-label={`Edit ${v.name}`}
                        onClick={() => setEditing(v.id)}
                        className="p-1.5 hover:text-fg"
                      >
                        <Pencil className="size-[13px]" />
                      </button>
                    </Tip>
                    <Menu>
                      <MenuTrigger aria-label={`More for ${v.name}`} className="p-1.5 outline-none hover:text-fg">
                        <Ellipsis className="size-[13px]" />
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => setEditing(v.id)}>
                          <Pencil /> Edit filters
                        </MenuItem>
                        <MenuItem destructive onSelect={() => void remove(v)}>
                          <Trash2 /> Delete view
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </span>
                ),
              },
            ]}
          />
        )}
      </div>
      <ViewDialog open={creating} onOpenChange={setCreating} stay />
      {editingView ? (
        <ViewDialog key={editingView.id} open onOpenChange={(v) => !v && setEditing(null)} view={editingView} stay />
      ) : null}
    </div>
  );
}
