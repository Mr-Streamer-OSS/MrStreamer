// Manage profiles, opened from the profile menu's PIN row (Paper A) by an adult viewer: which
// profiles are kids profiles, exactly what each may open, and the PIN. It asks for the PIN first
// once one is set, and sets the first one otherwise. Approvals name one source each: a channel,
// movie or series in one subscription, or one download or recording on this device. Approving a
// title online never approves its downloaded or recorded copy, nor the same title elsewhere.
// Nothing is saved until Save, which replaces the whole policy; a refused save keeps the draft for
// another try. The PIN lives only in this sheet's state and goes with it.
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  DEFAULT_PROFILE_ID,
  type KidsApproval,
  type KidsPolicy,
  type LocalProfile,
} from "@mrstreamer/contracts/profiles";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { Sheet } from "../../components/Sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import { NativeCheckbox } from "../../components/ui/checkbox.tsx";
import { SearchField } from "../../components/ui/search-field.tsx";
import { downloadsQuery } from "../../lib/downloads.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { Avatar, Failure, nameOf, PIN_MIN, PinInput, PinPrompt } from "./ProfileControls.tsx";
import {
  describeProfileError,
  pinRefused,
  profileListQuery,
  profileStatus,
  readKidsPolicy,
  saveKidsPolicy,
  subscribeProfiles,
} from "./profiles.ts";

/** Each kids profile's approvals, by profile id, in the order the policy listed them. */
type Draft = ReadonlyMap<string, readonly KidsApproval[]>;

const sameApproval = (a: KidsApproval, b: KidsApproval) =>
  a.kind === b.kind &&
  a.id === b.id &&
  ("subscriptionId" in a ? a.subscriptionId : null) ===
    ("subscriptionId" in b ? b.subscriptionId : null);

/** Each online approval's kind, as its row names it. */
const KIND_LABELS = {
  channel: () => t("Channel"),
  movie: () => t("Movie"),
  series: () => t("Series"),
} as const;

/** How many results of each kind a search shows; a closer search finds the rest. */
const SHOWN = 20;

/** Why a new PIN can't be saved yet, if it can't. */
const newPinProblem = (pin: string, again: string) =>
  pin.length < PIN_MIN
    ? t("A PIN has 4 to 12 digits.")
    : pin !== again
      ? t("The PINs don't match.")
      : null;

export function ProfileManager({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const owner = useSyncExternalStore(subscribeProfiles, profileStatus).owner;
  const list = useQuery(profileListQuery());
  const [pin, setPin] = useState("");
  const [wrongPin, setWrongPin] = useState(false);
  const [locked, setLocked] = useState(false);
  const [policy, setPolicy] = useState<KidsPolicy | null>(null);
  const [draft, setDraft] = useState<Draft>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [checked, setChecked] = useState(false);
  const pinField = useRef<HTMLInputElement>(null);

  // Without a PIN this answers only while none is set; otherwise main asks for it.
  const unlock = useMutation({
    mutationFn: () => readKidsPolicy(pin || undefined),
    onSuccess: (read) => {
      setPolicy(read);
      setDraft(new Map(read.profiles.map((row) => [row.id, row.approved])));
      setWrongPin(false);
    },
    onError: (cause) => {
      if (!pinRefused(cause)) return;
      setLocked(true);
      setWrongPin(pin !== "");
      setPin("");
      pinField.current?.focus();
    },
  });

  const { mutate: probe } = unlock;
  useEffect(() => probe(), [probe]);
  // The prompt appears only once main asked for the PIN; the keyboard goes to it then.
  useEffect(() => {
    if (locked) pinField.current?.focus();
  }, [locked]);

  const save = useMutation({
    mutationFn: () =>
      saveKidsPolicy(client, {
        pin: policy?.protected ? pin : undefined,
        newPin: newPin || undefined,
        profiles: [...draft].map(([id, approved]) => ({ id, approved: [...approved] })),
      }),
    onSuccess: onClose,
  });

  const profiles = (list.data ?? []).filter(
    (profile) => profile.id !== DEFAULT_PROFILE_ID && !profile.deleting,
  );

  const chosen =
    profiles.find((profile) => profile.id === selected && draft.has(profile.id)) ??
    profiles.find((profile) => draft.has(profile.id));

  // A first PIN is required; a new one is optional. Either way it must be typed twice.
  const pinProblem =
    !policy?.protected || newPin || confirmPin ? newPinProblem(newPin, confirmPin) : null;

  const setKids = (profile: LocalProfile, kids: boolean) => {
    const next = new Map(draft);

    // A new kids profile starts with nothing approved: an allowlist, not a filter.
    if (kids) next.set(profile.id, draft.get(profile.id) ?? []);
    else next.delete(profile.id);
    setDraft(next);

    if (kids) setSelected(profile.id);
  };

  const toggle = (approval: KidsApproval, on: boolean) => {
    if (!chosen) return;
    const approved = (draft.get(chosen.id) ?? []).filter((each) => !sameApproval(each, approval));
    setDraft(new Map(draft).set(chosen.id, on ? [...approved, approval] : approved));
  };

  const approved = chosen ? (draft.get(chosen.id) ?? []) : [];

  const isApproved = (approval: KidsApproval) =>
    approved.some((each) => sameApproval(each, approval));

  return (
    <Sheet onClose={onClose} short initialFocus={pinField}>
      <div className="flex min-h-96 flex-col bg-black px-8 pt-7 pb-6 text-sm text-foreground">
        <Dialog.Title className="text-2xl font-semibold">{t("Manage profiles")}</Dialog.Title>
        {policy ? (
          <>
            <div className="mt-6 grid gap-8 lg:grid-cols-[16rem_1fr]">
              <section aria-labelledby="kids-profiles">
                <h3 id="kids-profiles" className="pb-2 font-semibold">
                  {t("Kids profiles")}
                </h3>
                {list.isError ? (
                  <Failure
                    text={describeProfileError(list.error)}
                    onRetry={() => void list.refetch()}
                  />
                ) : profiles.length === 0 ? (
                  <p className="text-muted-foreground">
                    {t("Add a profile first, then make it a kids profile.")}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {profiles.map((profile) => (
                      <ProfileRow
                        key={profile.id}
                        profile={profile}
                        kids={draft.has(profile.id)}
                        count={draft.get(profile.id)?.length ?? 0}
                        selected={chosen?.id === profile.id}
                        active={profile.id === owner?.id}
                        onKids={(kids) => setKids(profile, kids)}
                        onSelect={() => setSelected(profile.id)}
                      />
                    ))}
                  </ul>
                )}
              </section>
              {chosen && (
                <Approvals
                  key={chosen.id}
                  name={nameOf(chosen)}
                  approved={approved}
                  isApproved={isApproved}
                  onToggle={toggle}
                />
              )}
            </div>
            <section aria-labelledby="kids-pin" className="mt-8 max-w-[34rem]">
              <h3 id="kids-pin" className="pb-2 font-semibold">
                {policy.protected ? t("Change PIN") : t("Set a PIN")}
              </h3>
              <div className="flex flex-wrap gap-2">
                <div className="w-40">
                  <PinInput
                    label={t("New PIN")}
                    value={newPin}
                    onChange={setNewPin}
                    invalid={checked && !!pinProblem}
                  />
                </div>
                <div className="w-40">
                  <PinInput
                    label={t("Confirm PIN")}
                    value={confirmPin}
                    onChange={setConfirmPin}
                    invalid={checked && !!pinProblem}
                  />
                </div>
              </div>
              <p className="pt-2 text-muted-foreground">{t("A PIN has 4 to 12 digits.")}</p>
            </section>
            <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
              {(save.isError || (checked && pinProblem)) && (
                <p role="alert" className="mr-auto min-w-0 flex-1">
                  {save.isError ? describeProfileError(save.error) : pinProblem}
                </p>
              )}
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                aria-busy={save.isPending || undefined}
                onClick={() => {
                  setChecked(true);

                  if (!pinProblem && !save.isPending) save.mutate();
                }}
              >
                {save.isPending ? t("Saving…") : t("Save")}
              </Button>
            </div>
          </>
        ) : locked ? (
          <div className="mt-6 max-w-[22rem] [&_form]:px-0">
            <PinPrompt
              field={pinField}
              prompt={t("Enter the PIN to manage profiles.")}
              action={t("Unlock")}
              busy={unlock.isPending}
              wrong={wrongPin}
              pin={pin}
              onPin={setPin}
              onSubmit={() => {
                if (pin && !unlock.isPending) unlock.mutate();
              }}
            />
            {unlock.isError && !pinRefused(unlock.error) && (
              <p role="alert" className="pt-2">
                {describeProfileError(unlock.error)}
              </p>
            )}
          </div>
        ) : unlock.isError ? (
          <div className="mt-6">
            <Failure text={describeProfileError(unlock.error)} onRetry={() => unlock.mutate()} />
          </div>
        ) : (
          <p aria-busy className="mt-6 text-muted-foreground">
            {t("Loading…")}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** One profile: whether it is a kids profile, and for a kids one, its approvals to edit. */
function ProfileRow({
  profile,
  kids,
  count,
  selected,
  active,
  onKids,
  onSelect,
}: {
  profile: LocalProfile;
  kids: boolean;
  count: number;
  selected: boolean;
  /** Main changes no profile while it is in use; switch away first. */
  active: boolean;
  onKids: (kids: boolean) => void;
  onSelect: () => void;
}) {
  const name = nameOf(profile);

  return (
    <li
      className={cn("flex min-h-11 items-center gap-2.5 rounded-lg px-2", selected && "bg-accent")}
    >
      <NativeCheckbox
        aria-label={t("Kids profile: {name}", { name })}
        checked={kids}
        disabled={active}
        onChange={(event) => onKids(event.target.checked)}
      />
      <Avatar profile={profile} />
      {active ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block text-xs leading-[14px] text-muted-foreground">{t("Current")}</span>
        </span>
      ) : kids ? (
        <button
          onClick={onSelect}
          aria-pressed={selected}
          className="min-w-0 flex-1 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate font-medium">{name}</span>
          <span className="block text-xs leading-[14px] text-muted-foreground">
            {t("{count} approved", { count })}
          </span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      )}
    </li>
  );
}

/**
 * What one kids profile may open: a search over the adult viewer's channels, movies and series,
 * what is already approved online, and every download and recording on this device.
 */
function Approvals({
  name,
  approved,
  isApproved,
  onToggle,
}: {
  name: string;
  approved: readonly KidsApproval[];
  isApproved: (approval: KidsApproval) => boolean;
  onToggle: (approval: KidsApproval, on: boolean) => void;
}) {
  const [text, setText] = useState("");
  const query = text.trim();
  const subscriptions = useQuery(queries.subscriptions());
  const channels = useQuery(queries.search(query));
  const titles = useQuery(queries.titleSearch(query));
  const downloads = useQuery(downloadsQuery());

  const recordings = useQuery({
    queryKey: ["profiles", "manage", "recordings"],
    queryFn: () => call("recordings.list"),
    gcTime: 0,
  });

  const source = (subscriptionId: string) => {
    const subscription = subscriptions.data?.find((each) => each.id === subscriptionId);

    return subscription ? subscriptionName(subscription) : t("Not available");
  };

  const online = approved.flatMap((each) => ("subscriptionId" in each ? [each] : []));
  const approvedChannels = online.filter((each) => each.kind === "channel");
  const known = useQuery(queries.channelsOf(approvedChannels));

  const movies = useQuery(
    queries.titles(
      "movie",
      online.filter((each) => each.kind === "movie"),
    ),
  );

  const series = useQuery(
    queries.titles(
      "series",
      online.filter((each) => each.kind === "series"),
    ),
  );

  const choice = (approval: KidsApproval, label: string, detail: string) => (
    <Choice
      key={`${approval.kind}:${"subscriptionId" in approval ? approval.subscriptionId : ""}:${approval.id}`}
      label={label}
      detail={detail}
      checked={isApproved(approval)}
      onChange={(on) => onToggle(approval, on)}
    />
  );

  // A title gathers versions, from one subscription or several; each is approved on its own and
  // named by the provider so two versions never read alike.
  const versions = (kind: TitleKind, items: readonly Title[]) =>
    items.flatMap((title) =>
      title.versions.map((version) =>
        choice(
          { kind, subscriptionId: version.subscriptionId, id: version.id },
          title.title,
          `${version.name ?? title.name} · ${source(version.subscriptionId)}`,
        ),
      ),
    );

  const titleOf = (kind: TitleKind, approval: OwnedId) =>
    (kind === "movie" ? movies : series).data?.find((title) =>
      title.versions.some(
        (version) =>
          version.subscriptionId === approval.subscriptionId && version.id === approval.id,
      ),
    );

  // Names for what is approved online come from three reads; the first in trouble speaks for them.
  const naming =
    [known, movies, series].find((read) => read.isError) ??
    [known, movies, series].find((read) => read.isPending && read.fetchStatus !== "idle") ??
    known;

  return (
    <section aria-labelledby="kids-approvals" className="min-w-0">
      <h3 id="kids-approvals" className="pb-2 font-semibold">
        {t("What {name} can open", { name })}
      </h3>
      <SearchField
        aria-label={t("Search channels, movies and series")}
        placeholder={t("Search channels, movies and series")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {query && (
        <>
          <Group
            title={t("Channels")}
            state={channels}
            items={(channels.data ?? [])
              .slice(0, SHOWN)
              .flatMap((channel) =>
                channel.variants.map((variant) =>
                  choice(
                    { kind: "channel", subscriptionId: channel.subscriptionId, id: variant.id },
                    channel.title,
                    `${variant.name} · ${source(channel.subscriptionId)}`,
                  ),
                ),
              )}
          />
          <Group
            title={t("Movies")}
            state={titles}
            items={versions("movie", titles.data?.movies.slice(0, SHOWN) ?? [])}
          />
          <Group
            title={t("Series")}
            state={titles}
            items={versions("series", titles.data?.series.slice(0, SHOWN) ?? [])}
          />
        </>
      )}
      <Group
        title={t("Approved online")}
        state={naming}
        items={online.map((approval) =>
          choice(
            approval,
            (approval.kind === "channel"
              ? known.data?.find(
                  (channel) =>
                    channel.subscriptionId === approval.subscriptionId &&
                    channel.variants.some((variant) => variant.id === approval.id),
                )?.title
              : titleOf(approval.kind, approval)?.title) ?? t("Not available"),
            [
              KIND_LABELS[approval.kind](),
              approval.kind === "channel"
                ? known.data
                    ?.filter((channel) => channel.subscriptionId === approval.subscriptionId)
                    .flatMap((channel) => channel.variants)
                    .find((variant) => variant.id === approval.id)?.name
                : titleOf(approval.kind, approval)?.versions.find(
                    (version) =>
                      version.subscriptionId === approval.subscriptionId &&
                      version.id === approval.id,
                  )?.name,
              source(approval.subscriptionId),
              approval.id,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        )}
      />
      <Group
        title={t("Downloads")}
        state={downloads}
        items={(downloads.data?.items ?? []).map((download) =>
          choice(
            { kind: "download", id: download.id },
            download.episodeName ? `${download.name} · ${download.episodeName}` : download.name,
            [download.year, download.subscription?.name].filter(Boolean).join(" · "),
          ),
        )}
      />
      <Group
        title={t("Recordings")}
        state={recordings}
        items={(recordings.data ?? []).map((recording) =>
          choice(
            { kind: "recording", id: recording.id },
            recording.title,
            `${recording.channelName} · ${formatDate(recording.start, "date")}`,
          ),
        )}
      />
    </section>
  );
}

/** A titled list of choices, saying when it is being read, failed, or has nothing. */
function Group({
  title,
  state,
  items,
}: {
  title: string;
  state: Pick<UseQueryResult, "isPending" | "isError" | "error" | "fetchStatus" | "refetch">;
  items: readonly ReactNode[];
}) {
  return (
    <div className="mt-5">
      <h4 className="pb-1 font-medium">{title}</h4>
      {state.isError ? (
        <Failure text={describeProfileError(state.error)} onRetry={() => void state.refetch()} />
      ) : state.isPending && state.fetchStatus !== "idle" ? (
        <p aria-busy className="py-2 text-muted-foreground">
          {t("Loading…")}
        </p>
      ) : items.length === 0 ? (
        <p className="py-2 text-muted-foreground">{t("None")}</p>
      ) : (
        <ul>{items}</ul>
      )}
    </div>
  );
}

/** One source to approve or not. */
function Choice({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li>
      <label className="flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-white/5">
        <NativeCheckbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
        <span className="max-w-[45%] flex-none truncate text-xs leading-[14px] text-muted-foreground">
          {detail}
        </span>
      </label>
    </li>
  );
}
