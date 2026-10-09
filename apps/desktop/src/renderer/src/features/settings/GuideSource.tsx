// A subscription's programme guide in Settings > Subscriptions: where it comes from, what it
// covers and since when, in the subscription's details, and the form under its row that gives it
// an XMLTV address of the viewer's own.
//   The address is checked before anything changes: Check downloads and reads the guide and says
// what it lists, and only Use this guide switches to it. A check can be called off, so Cancel
// stays offered while one runs; the switch itself can't. The address can hold a key, so the field
// starts empty every time and nothing here shows more of a saved one than its host.
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { GuideCandidate, GuideStatus } from "@mrstreamer/contracts/guide";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { comingTime, hostOf, pastTime, shortDay } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { keepGuideStatus, subscriptionName } from "../../lib/queries.ts";
import { Field } from "../connect/LoginForm.tsx";
import { Row, RowForm } from "./Rows.tsx";

/** What a switch of a subscription's guide is saved under, by which its row tells one is on its way. */
export const guideKey = (subscriptionId: string) => ["guide.source", subscriptionId];

/** Whose guide a subscription's own one is: its provider's, or its playlist's. */
const owner = (subscription: SubscriptionSummary) =>
  subscription.kind === "m3u" ? "playlist" : "provider";

/** The address a subscription's guide comes from in place of its own, or null for its own. */
const externalOf = (guide: GuideStatus | undefined) =>
  guide?.source.kind === "external" ? guide.source : null;

/**
 * The Guide row of a subscription's details, and under it the channels mapped by hand: how many
 * channels the guide covers and when it last downloaded, with Refresh, or Retry and the reason
 * once a download failed. Guide opens the form that changes where it comes from. Map waits while
 * a switch is on its way, as its form can be closed on one: the channels are mapped to the guide
 * switched to, never to one that is about to go.
 */
export function GuideRows({
  subscription,
  guide,
  onEdit,
  onMap,
}: {
  subscription: SubscriptionSummary;
  guide: GuideStatus | undefined;
  onEdit: () => void;
  onMap: () => void;
}) {
  const client = useQueryClient();
  const name = subscriptionName(subscription);
  const refresh = useMutation({
    mutationFn: () => call("guide.refresh", { subscriptionId: subscription.id }),
    onSuccess: (status) => keepGuideStatus(client, status),
  });
  const switching = useIsMutating({ mutationKey: guideKey(subscription.id) }) > 0;
  const now = Date.now();
  const external = externalOf(guide);
  const failure = refresh.error ? appError(refresh.error) : (guide?.failure ?? null);
  const fetchedAt = guide?.fetchedAt ?? null;
  const covered =
    guide && fetchedAt !== null
      ? guide.listed > 0
        ? t("{channels} of {listed} channels", { channels: guide.channels, listed: guide.listed })
        : t("{count} channels", { count: guide.channels })
      : t("not loaded yet");
  const note =
    guide?.availability === "none"
      ? t("none in this playlist")
      : [
          external && hostOf(external.origin),
          external?.locked ? t("needs its address again") : covered,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <>
      <Row label={t("Guide")} note={note}>
        <span className="text-muted-foreground">
          {refresh.isPending
            ? t("refreshing…")
            : guide?.availability !== "none" && fetchedAt !== null
              ? pastTime(fetchedAt, now)
              : ""}
        </span>
        {external?.locked ? (
          <Button
            size="sm"
            aria-label={t("Enter the guide address for {name}", { name })}
            onClick={onEdit}
          >
            {t("Enter address")}
          </Button>
        ) : (
          <>
            {failure ? (
              <Button
                size="sm"
                aria-label={t("Retry guide")}
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                {t("Retry")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("Refresh guide")}
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                <RotateCw />
              </Button>
            )}
            <Button
              variant={failure ? "ghost" : "secondary"}
              size="sm"
              aria-label={t("Guide for {name}", { name })}
              onClick={onEdit}
            >
              {t("Guide")}
            </Button>
          </>
        )}
      </Row>
      <div aria-live="polite">
        {failure && (
          <p className="mt-2 mb-1 text-sm text-destructive">
            {unanswered(subscription, guide, failure, now)}
          </p>
        )}
      </div>
      {guide?.availability === "available" && (
        <Row
          label={t("Mapped channels")}
          note={[
            t("{count} by hand", { count: guide.mapped }),
            guide.unresolved > 0 && t("{count} unresolved", { count: guide.unresolved }),
            t("{count} without programmes", {
              count: Math.max(0, guide.listed - guide.channels),
            }),
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Button
            size="sm"
            aria-label={t("Map channels of {name}", { name })}
            disabled={switching}
            onClick={onMap}
          >
            {t("Map")}
          </Button>
        </Row>
      )}
    </>
  );
}

/**
 * Why a guide's download failed, and what shows meanwhile. A guide from an address of the
 * viewer's own says since when its host hasn't answered, that the listings are the last it
 * downloaded, and that the subscription's own guide doesn't stand in for it.
 */
function unanswered(
  subscription: SubscriptionSummary,
  guide: GuideStatus | undefined,
  failure: AppError,
  now: number,
): string {
  const external = externalOf(guide);
  const kept = guide && guide.fetchedAt !== null ? pastTime(guide.fetchedAt, now) : null;
  if (!external) {
    return [describeError(failure), kept && t("Listings are from {time}.", { time: kept })]
      .filter(Boolean)
      .join(" ");
  }
  const host = hostOf(external.origin);
  const why =
    failure.kind === "unreachable" && guide?.failedAt
      ? t("{host} hasn't answered since {time}.", { host, time: pastTime(guide.failedAt, now) })
      : failure.kind === "provider-error"
        ? t("{host} answered with an error (HTTP {status}).", {
            host,
            status: String(failure.status),
          })
        : describeError(failure);
  const playlist = owner(subscription) === "playlist";
  const unused = kept
    ? playlist
      ? t("Listings are from {time}; the playlist's guide isn't used.", { time: kept })
      : t("Listings are from {time}; the provider's guide isn't used.", { time: kept })
    : playlist
      ? t("The playlist's guide isn't used.")
      : t("The provider's guide isn't used.");
  return `${why} ${unused}`;
}

/** An address typed with http://, which it and any key in it travel over unencrypted. */
function plainHttp(address: string): boolean {
  return /^http:\/\//i.test(address.trim());
}

/**
 * The form that gives a subscription's guide an XMLTV address, another one, or its own guide
 * back. Closing it, by Cancel or any other way, stops its check and drops what one found.
 */
export function GuideForm({
  subscription,
  guide,
  onDone,
}: {
  subscription: SubscriptionSummary;
  guide: GuideStatus | undefined;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const subscriptionId = subscription.id;
  const [address, setAddress] = useState("");
  /** What the check of the address in the field found, until the field changes. */
  const [candidate, setCandidate] = useState<GuideCandidate | null>(null);
  const typed = address.trim();
  const external = externalOf(guide);
  const whose = owner(subscription);

  useEffect(
    () => () => {
      void call("guide.cancelCheck", { subscriptionId }).catch(() => {});
    },
    [subscriptionId],
  );

  const check = useMutation({
    mutationFn: (checked: string) =>
      call("guide.check", { subscriptionId, ...(checked ? { address: checked } : {}) }),
    // The address it was sent with isn't kept past the form: it can hold a key.
    gcTime: 0,
  });
  const done = (status: GuideStatus) => {
    keepGuideStatus(client, status);
    onDone();
  };
  const use = useMutation({
    mutationKey: guideKey(subscriptionId),
    mutationFn: (candidateId: string) =>
      call("guide.use", { subscriptionId, candidate: candidateId }),
    onSuccess: done,
    // Whatever stopped the switch, the check no longer counts.
    onError: () => setCandidate(null),
  });
  const restore = useMutation({
    mutationKey: guideKey(subscriptionId),
    mutationFn: () => call("guide.restore", { subscriptionId }),
    onSuccess: done,
  });

  const switching = use.isPending || restore.isPending;
  const failure = [use.error, restore.error, check.error].find(Boolean);
  const error = failure ? appError(failure) : null;
  // A check the viewer called off, or that a later one took the place of, failed at nothing.
  const said =
    error && !(error.kind === "guide" && error.failure.kind === "cancelled")
      ? describeError(error)
      : null;
  /** Without an address typed, the one in use is checked again, when the keychain still has it. */
  const checkable = typed !== "" || (external !== null && !external.locked);

  /**
   * Checks what the field says, with what the try before said taken away. It is answered here
   * only while the field still says what was checked: changing it resets the check.
   */
  function runCheck() {
    setCandidate(null);
    use.reset();
    restore.reset();
    check.mutate(typed, { onSuccess: setCandidate });
  }

  function changeAddress(value: string) {
    setAddress(value);
    setCandidate(null);
    check.reset();
    use.reset();
    restore.reset();
  }

  return (
    <RowForm
      onSubmit={() => {
        if (switching || check.isPending) return;
        if (candidate) use.mutate(candidate.id);
        else if (checkable) runCheck();
      }}
    >
      <h2 className="mb-5 text-2xl font-semibold tracking-tight">
        {t("Guide for {name}", { name: subscriptionName(subscription) })}
      </h2>
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">
          {t("In use")}
          <div className="mt-2 text-base text-foreground">
            {external
              ? [
                  hostOf(external.origin),
                  t("key hidden"),
                  external.origin.startsWith("http:") && t("not encrypted"),
                  t("since {day}", { day: shortDay(external.since) }),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [
                  whose === "playlist" ? t("Playlist guide") : t("Provider guide"),
                  guide?.availability === "none" && t("none in this playlist"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </div>
        </div>
        {external?.locked && (
          <p className="text-[0.9375rem]">
            {t("Your keychain no longer gives Mr. Streamer the saved address from {host}.", {
              host: hostOf(external.origin),
            })}
          </p>
        )}
        <Field
          label={t("XMLTV address")}
          {...(external && !external.locked ? { hint: t("leave empty to keep") } : {})}
          note={
            plainHttp(address)
              ? t("Not encrypted. The address, and any key in it, travels as plain text.")
              : null
          }
        >
          <Input
            value={address}
            onChange={(event) => changeAddress(event.target.value)}
            placeholder="https://…"
            autoComplete="off"
            autoFocus
          />
        </Field>
      </div>
      <div aria-live="polite">
        {candidate && (
          <p role="status" className="mt-4 text-[0.9375rem]">
            {found(candidate, Date.now())}
            {!candidate.sameSource && guide && guide.mapped > 0
              ? ` ${t("Using it clears your {count} mapped channels.", { count: guide.mapped })}`
              : ""}
          </p>
        )}
        {said && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {said}
          </p>
        )}
      </div>
      <div className="mt-6 flex items-center gap-3">
        {candidate ? (
          <>
            <Button type="submit" variant="primary" disabled={switching}>
              {use.isPending ? t("Switching…") : t("Use this guide")}
            </Button>
            <Button variant="ghost" disabled={switching} onClick={runCheck}>
              {t("Check again")}
            </Button>
          </>
        ) : (
          <Button
            type="submit"
            variant="primary"
            disabled={!checkable || check.isPending || switching}
          >
            {check.isPending ? t("Checking…") : t("Check")}
          </Button>
        )}
        {external && (
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={switching}
            onClick={() => restore.mutate()}
          >
            {restore.isPending
              ? t("Going back…")
              : whose === "playlist"
                ? t("Use playlist guide")
                : t("Use provider guide")}
          </Button>
        )}
      </div>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground/80">
        {external || candidate
          ? [
              whose === "playlist"
                ? t("Your playlist's guide isn't used while this address is set.")
                : t("Your provider's guide isn't used while this address is set."),
              t("Times follow the guide's own offsets."),
            ].join(" ")
          : t(
              "Check downloads the guide and says what it covers. Nothing changes until you choose Use this guide.",
            )}
        {external && guide && guide.mapped > 0
          ? ` ${
              whose === "playlist"
                ? t("Use playlist guide also clears your {count} mapped channels.", {
                    count: guide.mapped,
                  })
                : t("Use provider guide also clears your {count} mapped channels.", {
                    count: guide.mapped,
                  })
            }`
          : ""}
      </p>
    </RowForm>
  );
}

/** What a check found: "Checked: 1,204 channels in this guide, 412 of your 1,180 match by id." */
function found(candidate: GuideCandidate, now: number): string {
  const until = comingTime(candidate.until, now);
  return candidate.listed > 0
    ? t(
        "Checked: {channels} channels in this guide, {matched} of your {listed} match by id. Programmes until {until}.",
        {
          channels: candidate.guideChannels,
          matched: candidate.matched,
          listed: candidate.listed,
          until,
        },
      )
    : t("Checked: {channels} channels in this guide. Programmes until {until}.", {
        channels: candidate.guideChannels,
        until,
      });
}
