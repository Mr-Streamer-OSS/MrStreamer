import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { Recording } from "@mrstreamer/contracts/recordings";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { useLiveRecordings } from "../recordings/recordings.ts";

type StatusAction =
  | { method: "updates.check" | "updates.download" }
  | { method: "updates.downloadVersion"; version: string };

/**
 * When a ready update installs while `live` recordings' time goes on: once the one that stops last
 * has, as main waits for nothing to record. Null while nothing records.
 */
export function waitText(live: readonly Recording[]): string | null {
  const [last] = live;
  if (!last) return null;
  const time = formatDate(last.stop, "time");
  return live.length === 1
    ? t("It installs when {title} finishes at {time}.", { title: last.title, time })
    : t("It installs when the last recording finishes at {time}.", { time });
}

/**
 * The update status and the actions on it, shared by the top bar's notice and Settings: one
 * service state, whichever the viewer uses. Every action answers with the new status. While a
 * recording's time goes on (`recording`), a ready update's restart waits for it in main, and
 * Restart now stops it first.
 */
export function useUpdates() {
  const client = useQueryClient();
  const status = useQuery(queries.updates());
  const store = (next: UpdateStatus) => client.setQueryData(queries.updates().queryKey, next);
  const action = useMutation({
    mutationFn: (action: StatusAction) =>
      action.method === "updates.downloadVersion"
        ? call(action.method, { version: action.version })
        : call(action.method),
    onSuccess: store,
  });
  const changingChannel = useRef(false);
  const live = useLiveRecordings();
  /**
   * Installs and restarts, once no recording's time goes on. The call only settles when the app
   * is still running: the release was refused or the install couldn't start, which Settings then
   * shows, or it was put off or replaced while it waited, which needs nothing shown.
   */
  const restart = () => {
    const showSettings = () =>
      useUi.setState({ settings: "updates", settingsTarget: "update-check", updateDialog: null });
    call("updates.restart")
      .then(() => call("updates.status"))
      .then((now) => {
        if (now.update.kind === "failed") showSettings();
      }, showSettings);
  };
  const setChannel = useMutation({
    mutationFn: (channel: Channel) => call("updates.setChannel", { channel }),
    onSuccess: store,
    onSettled: () => {
      changingChannel.current = false;
    },
  });
  return {
    status: status.data,
    statusRead: status,
    channelChange: setChannel,
    actionState: action,
    check: () => action.mutate({ method: "updates.check" }),
    download: () => action.mutate({ method: "updates.download" }),
    downloadVersion: (version: string) =>
      action.mutate({ method: "updates.downloadVersion", version }),
    setChannel: (channel: Channel) => {
      if (changingChannel.current || setChannel.isPending) return;
      changingChannel.current = true;
      setChannel.mutate(channel);
    },
    cancel: () => void call("updates.cancel").catch(() => {}),
    dismiss: (version: string) => void call("updates.dismiss", { version }).then(store, () => {}),
    /** Opens the app's page in the Microsoft Store, which updates a copy it installed. */
    openStore: () => void call("updates.openStore").catch(() => {}),
    /** The recordings whose time goes on, which a ready update waits for. */
    recording: live,
    restart,
    /** Stops what records, keeping what it captured, then installs and restarts. */
    restartNow: () =>
      void Promise.allSettled(live.map(({ id }) => call("recordings.stop", { id }))).then(restart),
  };
}
