// Explicit group mapping over Settings. Pages and samples contain names and reasons, never links.
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PLAYLIST_OMISSION_LABELS, type PlaylistMode } from "@mrstreamer/contracts/playlist";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { Sheet } from "../../components/Sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName } from "../../lib/queries.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { cn } from "../../lib/utils.ts";
import { Row } from "./Rows.tsx";

const PAGE = 50;
const MODES: readonly { mode: PlaylistMode; label: string }[] = [
  { mode: "live", label: "Live TV" },
  { mode: "movie", label: "Movies" },
  { mode: "series", label: "Series" },
  { mode: "skip", label: "Skip" },
];

export function PlaylistMap({
  subscription,
  onClose,
}: {
  subscription: SubscriptionSummary;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 120);
  const [paging, setPaging] = useState({ query: "", offset: 0 });
  const offset = paging.query === query ? paging.offset : 0;
  const groups = useQuery(queries.playlistGroups(subscription.id, query, offset, PAGE));
  const [selected, setSelected] = useState<string | null>(null);
  const picked =
    groups.data?.groups.find((each) => each.group === selected) ?? groups.data?.groups[0];
  const save = useMutation({
    mutationFn: ({ group, mode }: { group: string; mode: PlaylistMode }) =>
      call("playlist.map", { subscriptionId: subscription.id, group, mode }),
    onSuccess: async (fresh) => {
      client.setQueryData(queries.subscriptions().queryKey, (all) =>
        all?.map((each) => (each.id === fresh.id ? fresh : each)),
      );
      await client.invalidateQueries({ queryKey: ["playlist", subscription.id] });
    },
  });
  const failed = save.error ?? groups.error;
  return (
    <Sheet onClose={onClose} overSettings>
      <div className="flex h-full min-h-96 flex-col bg-black px-8 pt-7 pb-6 text-white">
        <Dialog.Title className="text-2xl font-semibold">Map playlist groups</Dialog.Title>
        <p className="mt-2 text-sm">{subscriptionName(subscription)} · Picks apply immediately</p>
        {failed && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {describeError(appError(failed))}
          </p>
        )}
        <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(12rem,1fr)_2fr] gap-8">
          <div className="flex min-h-0 flex-col">
            <Input
              aria-label="Search playlist groups"
              placeholder="Search groups"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="mt-3 flex-1 overflow-y-auto" aria-label="Playlist groups">
              {groups.data?.groups.map((group) => (
                <button
                  key={group.group}
                  onClick={() => setSelected(group.group)}
                  aria-pressed={picked?.group === group.group}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 border-b border-white/10 px-2 py-3 text-left text-sm",
                    picked?.group === group.group && "bg-white/10",
                  )}
                >
                  <span className="min-w-0 truncate">{group.name}</span>
                  <span className="shrink-0">
                    {group.entries} ·{" "}
                    {MODES.find((each) => each.mode === group.mode)?.label ?? "Unmapped"}
                  </span>
                </button>
              ))}
              {groups.isPending && <p className="py-3 text-sm">Reading playlist…</p>}
              {groups.data?.total === 0 && <p className="py-3 text-sm">No groups found.</p>}
            </div>
            <Pages
              offset={offset}
              total={groups.data?.total ?? 0}
              onChange={(next) => setPaging({ query, offset: next })}
            />
          </div>
          {picked && (
            <div className="min-h-0 overflow-y-auto">
              <h2 className="text-xl font-semibold">{picked.name}</h2>
              <fieldset className="mt-4 flex flex-wrap gap-2" disabled={save.isPending}>
                <legend className="sr-only">Import this group as</legend>
                {MODES.map(({ mode, label }) => (
                  <Button
                    key={mode}
                    disabled={save.isPending}
                    aria-pressed={picked.mode === mode}
                    variant={picked.mode === mode ? "primary" : "ghost"}
                    onClick={() => save.mutate({ group: picked.group, mode })}
                  >
                    {label}
                  </Button>
                ))}
              </fieldset>
              <p className="mt-4 text-sm">
                New groups wait for mapping. Entries in groups with different mappings stay out.
              </p>
              <h3 className="mt-7 text-sm font-semibold">Sample entries</h3>
              <ul className="mt-2">
                {picked.samples.map((sample, index) => (
                  <li key={index} className="border-b border-white/10 py-3 text-sm">
                    <p className="break-words">{sample.name}</p>
                    {sample.reason && (
                      <p className="mt-1">{PLAYLIST_OMISSION_LABELS[sample.reason]}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Status and full omissions are confined to the expanded Settings row. */
export function PlaylistRows({
  subscription,
  onMap,
}: {
  subscription: SubscriptionSummary;
  onMap: () => void;
}) {
  const groups = useQuery({
    ...queries.playlistGroups(subscription.id, "", 0, 1),
    enabled: !subscription.needsSecret,
  });
  const [show, setShow] = useState(false);
  const [offset, setOffset] = useState(0);
  const omissions = useQuery({
    ...queries.playlistOmissions(subscription.id, offset, PAGE),
    enabled: show && !subscription.needsSecret,
  });
  const status = groups.data?.status;
  return (
    <>
      <Row label="Groups">
        <span>{status?.groups.toLocaleString() ?? "…"}</span>
        <Button variant="ghost" size="sm" disabled={subscription.needsSecret} onClick={onMap}>
          Map
        </Button>
      </Row>
      <Row label="Movies">{status?.movies.toLocaleString() ?? "…"}</Row>
      <Row label="Series">{status?.series.toLocaleString() ?? "…"}</Row>
      <Row label="Left out">
        <span>{status?.omitted.toLocaleString() ?? "…"}</span>
        {!!status?.omitted && (
          <Button variant="ghost" size="sm" onClick={() => setShow((now) => !now)}>
            {show ? "Hide" : "Show"}
          </Button>
        )}
      </Row>
      {groups.error && (
        <p role="alert" className="text-sm text-destructive">
          {describeError(appError(groups.error))}
        </p>
      )}
      {show && (
        <div className="mt-2 max-h-80 overflow-y-auto" aria-label="Left-out playlist entries">
          {omissions.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(appError(omissions.error))}
            </p>
          )}
          <ul>
            {omissions.data?.entries.map((entry, index) => (
              <li key={index} className="border-b border-white/10 py-2 text-sm">
                <p className="break-words">{entry.name}</p>
                <p>
                  {entry.groups.map((group) => group || "Ungrouped").join(" · ")} ·{" "}
                  {PLAYLIST_OMISSION_LABELS[entry.reason]}
                </p>
              </li>
            ))}
          </ul>
          <Pages offset={offset} total={omissions.data?.total ?? 0} onChange={setOffset} />
        </div>
      )}
    </>
  );
}

function Pages({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      <Button
        variant="ghost"
        size="sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE))}
      >
        Previous
      </Button>
      <span>
        {total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : "0 entries"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={offset + PAGE >= total}
        onClick={() => onChange(offset + PAGE)}
      >
        Next
      </Button>
    </div>
  );
}
