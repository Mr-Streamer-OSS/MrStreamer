import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";
import { useState } from "react";
import type { SubscriptionSummary } from "../../../../shared/subscription.ts";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError, formatDate } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { player } from "../../player/player.ts";
import { UpdatesSection } from "../updates/UpdatesSection.tsx";

/** The subscription and what to do with it, in a sheet over the picture. Opens with ⌘, or Ctrl ,. */
export function SettingsSheet() {
  const open = useUi((state) => state.settingsOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useUi.setState({ settingsOpen: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-y-3 right-3 z-50 flex w-[30rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto rounded-3xl bg-popover p-8 shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-300 ease-drawer data-ending-style:translate-x-6 data-ending-style:opacity-0 data-starting-style:translate-x-6 data-starting-style:opacity-0">
          <div className="mb-8 flex items-center justify-between">
            <Dialog.Title className="text-2xl font-semibold tracking-tight">Settings</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
              <X />
            </Dialog.Close>
          </div>
          <Subscription />
          <UpdatesSection />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Subscription() {
  const client = useQueryClient();
  const subscription = useQuery(queries.subscription());
  const status = useQuery(queries.libraryStatus());
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = useMutation({
    mutationFn: () => call("library.refresh"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["library"] }),
  });
  const remove = useMutation({
    mutationFn: () => call("subscription.remove"),
    onSuccess: async () => {
      player.reset();
      useUi.setState({ settingsOpen: false, categoryId: null, guideDepth: 0 });
      await client.resetQueries();
    },
  });

  if (!subscription.data) return null;
  const { account } = subscription.data;
  const rows: [string, string][] = [
    ["Server", subscription.data.server],
    ["Username", subscription.data.username],
    ["Status", accountLine(account.state, account.expiresAt)],
    [
      "Connections",
      account.maxConnections ? `${account.maxConnections} at a time` : "Not reported",
    ],
    [
      "Channels",
      status.data?.fetchedAt
        ? `${status.data.channelCount.toLocaleString()} · updated ${relativeTime(status.data.fetchedAt)}`
        : "Not loaded yet",
    ],
  ];
  // A failed refresh keeps the previous channels, but says why the list may be out of date.
  const failed = refresh.error ?? remove.error;
  const error = failed ? appError(failed) : (status.data?.failure ?? null);

  return (
    <section>
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">Subscription</h3>
      <dl className="mb-8 space-y-3.5 text-[0.9375rem]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4">
            <dt className="w-28 flex-none text-muted-foreground">{label}</dt>
            <dd className="m-0 min-w-0 truncate">{value}</dd>
          </div>
        ))}
      </dl>

      {error && <p className="mb-4 text-sm text-destructive">{describeError(error)}</p>}

      {confirmRemove ? (
        <div className="rounded-2xl bg-white/5 p-5">
          <p className="mb-4 text-[0.9375rem]">
            Remove the login and channel list from this device?
          </p>
          <div className="flex gap-3">
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            onClick={() => useUi.setState({ editingLogin: true, settingsOpen: false })}
          >
            Edit login
          </Button>
          <Button variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RotateCw />
            {refresh.isPending ? "Refreshing…" : "Refresh channels"}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        </div>
      )}
    </section>
  );
}

function accountLine(
  state: SubscriptionSummary["account"]["state"],
  expiresAt: string | null,
): string {
  if (state === "active") return expiresAt ? `Active until ${formatDate(expiresAt)}` : "Active";
  if (state === "unknown") return expiresAt ? `Expires ${formatDate(expiresAt)}` : "Unknown";
  return state[0]?.toUpperCase() + state.slice(1);
}

function relativeTime(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(new Date(epochMs).toISOString());
}
