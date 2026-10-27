// The launch's update reminder: a small centered dialog over the dimmed page, for a Stable copy at
// least two releases behind (the service decides, in `UpdateStatus.reminder`). It waits until the
// viewer browses: nothing plays over the page and no Settings, search, sheet or update panel is
// open; Home's muted preview doesn't count. Then the main process allows it once per launch
// (`updates.showReminder`), and records display only once the popup mounts. An answer that
// arrives after the viewer started playing waits in the UI store for the next time they browse.
// Download and Not now both close it, Escape too, and the keyboard returns where it was. The top
// bar's Update stays.
import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect } from "react";
import { t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";
import { NOTE_LINES, useKeptUpdate } from "./UpdateNotice.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

type Ui = ReturnType<typeof useUi.getState>;

/** Something the viewer is in, over the page, that the reminder doesn't interrupt. */
const covered = (ui: Ui) =>
  ui.watching ||
  ui.playingTitle ||
  ui.settings !== null ||
  ui.searchOpen ||
  ui.details !== null ||
  ui.savedEntry !== null;

/** The viewer browses a page, with nothing over it, the update panel included. */
const browsing = (ui: Ui) => !covered(ui) && ui.updateDialog === null;

export function UpdateReminder() {
  const {
    status,
    statusRead: { refetch },
    downloadVersion,
  } = useUpdates();
  const reminder = useUi((state) => state.updateReminder);
  const free = useUi(browsing);
  const blocked = useUi(covered);
  const open = useUi((state) => state.updateDialog === "reminder");
  const version = useKeptUpdate();
  // The service names only the release on offer, so a due reminder is always downloadable.
  const due = status?.reminder?.version ?? null;
  const recordDisplay = useCallback(
    (node: HTMLElement | null) => {
      if (node && version) void call("updates.reminderShown", { version }).catch(() => {});
    },
    [version],
  );

  // Validate the offer when browsing. A stale answer refreshes status before another attempt.
  useEffect(() => {
    if (reminder !== null || !due || !free) return;
    useUi.setState({ updateReminder: "asking" });
    const settle = (next: Ui["updateReminder"]) =>
      useUi.setState((state) =>
        state.updateReminder === "asking" ? { updateReminder: next } : {},
      );
    call("updates.showReminder", { version: due }).then(
      async (allowed) => {
        if (allowed) settle({ allowed: due });
        else {
          const refreshed = await refetch();
          settle(refreshed.isError ? "done" : null);
        }
      },
      () => settle("done"),
    );
  }, [reminder, due, free, refetch]);

  // Permission belongs to one version. Changed or withdrawn offers must be validated again.
  useEffect(() => {
    if (typeof reminder !== "object" || reminder === null || !("allowed" in reminder)) return;
    if (due !== reminder.allowed) useUi.setState({ updateReminder: null });
    else if (free) useUi.setState({ updateReminder: { kept: due }, updateDialog: "reminder" });
  }, [reminder, due, free]);

  // Shortcuts and changed offers close the dialog; its Download must describe the current target.
  useEffect(() => {
    if (
      open &&
      (blocked ||
        status?.update.kind !== "available" ||
        status.update.version !== version ||
        status.checked?.failure != null)
    ) {
      useUi.setState({ updateDialog: null });
    }
  }, [open, blocked, status, version]);

  if (!status || !version) return null;
  const notes = status.offer?.version === version ? noteItems(status.offer.notes) : [];
  const close = () => useUi.setState({ updateDialog: null });
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/62 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          ref={recordDisplay}
          data-update-reminder
          className="fixed top-[44%] left-1/2 z-50 flex w-[23.75rem] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col rounded-2xl bg-popover px-5.5 pt-5.5 pb-4.5 shadow-[0_24px_64px_rgb(0_0_0/70%)] ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          <Dialog.Title className="text-xl leading-[1.625rem] font-semibold tracking-[-0.02em] text-white">
            {t("Update to {version}", { version })}
          </Dialog.Title>
          <Dialog.Description className="pt-0.75 text-[0.78125rem] leading-[1.125rem] text-muted-foreground">
            {t("You have {version}", { version: status.version })} ·{" "}
            {status.channel === "nightly" ? t("Nightly") : t("Stable")}
          </Dialog.Description>
          {notes.length > 0 && (
            <ul className="flex flex-col gap-1.25 pt-3.5 text-[0.8125rem] leading-[1.125rem] text-foreground/85">
              {notes.slice(0, NOTE_LINES).map((item) => (
                <li key={item.text}>
                  <span aria-hidden>• </span>
                  {item.text}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-1.75 pt-5">
            <Button
              variant="primary"
              size="sm"
              className="px-3.75 text-xs shadow-none"
              onClick={() => {
                downloadVersion(version);
                close();
              }}
            >
              {t("Download")}
            </Button>
            <Button variant="ghost" size="sm" className="px-3.25 text-xs" onClick={close}>
              {t("Not now")}
            </Button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                useUi.setState({
                  settings: "updates",
                  settingsTarget: "update-check",
                  updateDialog: null,
                })
              }
              className="ml-auto text-xs text-muted-foreground hover:text-white"
            >
              {t("Release notes")} ›
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
