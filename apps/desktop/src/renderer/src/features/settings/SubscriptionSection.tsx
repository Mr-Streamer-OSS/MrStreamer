// Settings > Subscription, for the one account: how the provider says it stands, asked again
// when the tab opens, the login, and what was loaded from it, each list with its own refresh, so
// one that failed can be fetched again alone. The server shows, with a note when the login travels
// over plain http; the password never does.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { resetForAccount, useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError, formatDate } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { player } from "../../player/player.ts";
import { Row, Section } from "./Rows.tsx";

const DAY_MS = 24 * 60 * 60 * 1000;

export function SubscriptionSection() {
  const client = useQueryClient();
  const subscription = useQuery(queries.subscription());
  const recheck = useMutation({
    mutationFn: () => call("subscription.recheck"),
    onSuccess: (fresh) => client.setQueryData(queries.subscription().queryKey, fresh),
  });
  // The connections in use change all the time: ask when the tab opens. Offline, the last
  // answer stays.
  const { mutate } = recheck;
  useEffect(() => mutate(), [mutate]);

  if (!subscription.data) return null;
  const { account, username, server, needsPassword } = subscription.data;
  return (
    <>
      <Section title="Account">
        <Row label="Status" note={needsPassword ? "needs your password again" : undefined}>
          {stateName(account.state)}
        </Row>
        <Row label="Expires">{expiry(account.expiresAt)}</Row>
        <Row label="Connections">{connections(account)}</Row>
        <Row label="Login" note={server.startsWith("http:") ? "not encrypted" : undefined}>
          <span className="truncate">
            {username} @ {hostOf(server)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => useUi.setState({ editingLogin: true, settings: null })}
          >
            Edit
          </Button>
        </Row>
      </Section>
      <Catalogue />
      <Remove />
    </>
  );
}

/** What was loaded from the provider, each list refreshed on its own. */
function Catalogue() {
  const client = useQueryClient();
  const channels = useQuery(queries.libraryStatus());
  const guide = useQuery(queries.guideStatus());
  const titles = useQuery(queries.onDemandStatus());
  const refreshChannels = useMutation({
    mutationFn: () => call("library.refresh"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["library"] }),
  });
  // A new guide or new lists reach every view through `guide.updated` and `ondemand.updated`.
  const refreshGuide = useMutation({
    mutationFn: () => call("guide.refresh"),
    onSuccess: (status) => client.setQueryData(queries.guideStatus().queryKey, status),
  });
  const refreshTitles = useMutation({
    mutationFn: () => call("ondemand.refresh"),
    onSuccess: (status) => client.setQueryData(queries.onDemandStatus().queryKey, status),
  });
  const titleCount = titles.data ? titles.data.movies + titles.data.series : 0;
  return (
    <Section title="Catalogue">
      <List
        label="Channels"
        count={channels.data?.channelCount ?? 0}
        fetchedAt={channels.data?.fetchedAt ?? null}
        failure={
          refreshChannels.error ? appError(refreshChannels.error) : (channels.data?.failure ?? null)
        }
        refreshing={refreshChannels.isPending}
        onRefresh={() => refreshChannels.mutate()}
      />
      <List
        label="Guide"
        count={guide.data?.channels ?? 0}
        unit="channels"
        fetchedAt={guide.data?.fetchedAt ?? null}
        failure={refreshGuide.error ? appError(refreshGuide.error) : null}
        refreshing={refreshGuide.isPending}
        onRefresh={() => refreshGuide.mutate()}
      />
      <List
        label="Movies and series"
        count={titleCount}
        fetchedAt={titles.data?.fetchedAt ?? null}
        failure={
          refreshTitles.error ? appError(refreshTitles.error) : (titles.data?.failure ?? null)
        }
        refreshing={refreshTitles.isPending}
        onRefresh={() => refreshTitles.mutate()}
      />
    </Section>
  );
}

/** One list: how many, how long ago, why the last refresh failed, and Refresh. */
function List({
  label,
  count,
  unit,
  fetchedAt,
  failure,
  refreshing,
  onRefresh,
}: {
  label: string;
  count: number;
  /** What `count` counts, when not the list itself. */
  unit?: string;
  fetchedAt: number | null;
  failure: AppError | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <Row
        label={label}
        note={
          fetchedAt === null
            ? "not loaded yet"
            : [count.toLocaleString(), unit].filter(Boolean).join(" ")
        }
      >
        <span className="text-muted-foreground">
          {refreshing ? "refreshing…" : fetchedAt === null ? "" : relativeTime(fetchedAt)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Refresh ${label.toLowerCase()}`}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RotateCw />
        </Button>
      </Row>
      {failure && <p className="mt-2 mb-1 text-sm text-destructive">{describeError(failure)}</p>}
    </>
  );
}

/** Takes the login and everything loaded with it off this device, once confirmed. */
function Remove() {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => call("subscription.remove"),
    onSuccess: async () => {
      player.reset();
      resetForAccount();
      useUi.setState({ settings: null });
      await client.resetQueries();
    },
  });
  if (!confirming) {
    return (
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setConfirming(true)}
        className="text-[0.9375rem] text-muted-foreground hover:text-white"
      >
        Remove subscription
      </button>
    );
  }
  return (
    <div>
      <p className="mb-3 text-[0.9375rem]">
        Remove the login, and the lists loaded with it, from this device?
      </p>
      <div className="flex gap-3">
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Remove
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
      {remove.error && (
        <p className="mt-3 text-sm text-destructive">{describeError(appError(remove.error))}</p>
      )}
    </div>
  );
}

function stateName(state: SubscriptionSummary["account"]["state"]): string {
  return state[0]?.toUpperCase() + state.slice(1);
}

/** "12 Mar 2027 · 163 days", or how long ago it ended. */
function expiry(expiresAt: string | null): string {
  if (!expiresAt) return "No end date";
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / DAY_MS);
  const left = days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : "ended";
  return `${formatDate(expiresAt)} · ${left}`;
}

/** "1 of 2 in use", as the provider counts them, this app's own stream included. */
function connections(account: SubscriptionSummary["account"]): string {
  const { maxConnections: max, activeConnections: active } = account;
  if (max === null) return active === null ? "Not reported" : `${active} in use`;
  return `${active ?? 0} of ${max} in use`;
}

/** The server's host, without its scheme: "tv.example.net:8080". */
function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

function relativeTime(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(new Date(epochMs).toISOString());
}
