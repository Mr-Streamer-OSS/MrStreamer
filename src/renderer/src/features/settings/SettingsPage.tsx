import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { SubscriptionSummary } from "../../../../shared/subscription.ts";
import { isTyping } from "../../app/platform.ts";
import { useUi, type SettingsTab } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { appError, describeError, formatDate } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { player } from "../../player/player.ts";
import { cn } from "../../lib/utils.ts";
import { UpdatesSection } from "../updates/UpdatesSection.tsx";
import { useUpdates } from "../updates/use-updates.ts";

const TABS: readonly { value: SettingsTab; label: string }[] = [
  { value: "subscription", label: "Subscription" },
  { value: "updates", label: "Updates" },
  { value: "about", label: "About" },
];

const REPOSITORY_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer";

/**
 * Settings, a page over the current view, so a channel keeps playing underneath. Opens with ⌘,
 * or Ctrl , on the tab its opener asks for; Escape goes back.
 */
export function SettingsPage() {
  const tab = useUi((state) => state.settings);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || isTyping(event)) return;
      // A dialog over the page closes itself first.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      if (!useUi.getState().settings) return;
      useUi.setState({ settings: null });
      // Handled: the view underneath must not take the same Escape.
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!tab) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <WindowBar className="bg-black" />
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 flex-none border-r border-border px-4 pt-4">
          <h1 className="mb-4 px-3 text-2xl font-semibold tracking-tight">Settings</h1>
          {TABS.map((entry) => (
            <button
              key={entry.value}
              aria-current={entry.value === tab ? "page" : undefined}
              onClick={() => useUi.setState({ settings: entry.value })}
              className={cn(
                "mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-[0.9375rem] transition-colors",
                entry.value === tab
                  ? "bg-white/10 text-white"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white",
              )}
            >
              {entry.label}
            </button>
          ))}
          <p className="mt-6 px-3 text-xs text-muted-foreground">Esc to go back</p>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-10 pt-6 pb-10">
          <div className="max-w-[40rem]">
            {tab === "subscription" && <Subscription />}
            {tab === "updates" && <UpdatesSection />}
            {tab === "about" && <About />}
          </div>
        </main>
      </div>
    </div>
  );
}

/** The installed version, where the project lives, and how to report a bug. */
function About() {
  const { status } = useUpdates();
  const rows: [string, ReactNode][] = [
    ["Version", status?.version ?? ""],
    ["Website", <Link href="https://mrstreamer.app">mrstreamer.app</Link>],
    [
      "Source",
      <>
        <Link href={REPOSITORY_URL}>GitHub</Link> · GPL-3.0
      </>,
    ],
    ["Includes", "FFmpeg and x264, under the GPL"],
  ];
  return (
    <section>
      <Rows rows={rows} />
      <Button
        variant="secondary"
        render={<a href={`${REPOSITORY_URL}/issues/new/choose`} target="_blank" rel="noreferrer" />}
      >
        Report a bug
      </Button>
    </section>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="mb-8 space-y-3.5 text-[0.9375rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-4">
          <dt className="w-28 flex-none text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
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
      useUi.setState({ settings: null, categoryId: null, guideDepth: 0 });
      await client.resetQueries();
    },
  });

  if (!subscription.data) return null;
  const { account } = subscription.data;
  const rows: [string, ReactNode][] = [
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
      <Rows rows={rows} />

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
            onClick={() => useUi.setState({ editingLogin: true, settings: null })}
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
