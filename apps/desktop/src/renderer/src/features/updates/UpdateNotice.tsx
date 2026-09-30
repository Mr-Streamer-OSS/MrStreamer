// The quiet notice in the top bar: an update waiting, downloading or ready. It fades with the
// other controls while watching. Clicking it opens a panel with the next step: Download, then
// Restart once it's ready. "Not now" hides the notice for that version; Settings still offers it.
import { Popover } from "@base-ui/react/popover";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

/** How many lines of the notes the panel shows before pointing to Settings. */
const NOTE_LINES = 4;

/** Whether the top bar shows the notice at all. */
function noticed(status: UpdateStatus): boolean {
  const { update, dismissed } = status;
  switch (update.kind) {
    case "downloading":
    case "ready":
      return true;
    case "available":
      return dismissed !== update.version;
    case "failed":
      return update.step !== "check" && dismissed !== update.version;
    default:
      return false;
  }
}

export function UpdateNotice({ overlay }: { overlay: boolean }) {
  const { status } = useUpdates();
  const open = useUi((state) => state.updateDialog === "panel");
  if (!status || (!noticed(status) && !open)) return null;
  const { update } = status;
  const label =
    update.kind === "downloading"
      ? `Updating · ${update.percent} %`
      : update.kind === "ready"
        ? "Restart to update"
        : update.kind === "failed"
          ? "Update stopped"
          : "Update";
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => useUi.setState({ updateDialog: next ? "panel" : null })}
    >
      <Popover.Trigger
        render={
          <Button variant={overlay ? "media" : "ghost"} size="sm" className="text-white">
            {update.kind === "available" && (
              <span aria-hidden className="size-1.5 rounded-full bg-white" />
            )}
            {label}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Popover.Popup className="no-drag w-[22rem] rounded-2xl bg-popover p-5 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <UpdatePanel status={status} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UpdatePanel({ status }: { status: UpdateStatus }) {
  const { download, cancel, restart, dismiss } = useUpdates();
  const { update, offer, channel } = status;
  const version = "version" in update ? update.version : (offer?.version ?? "");
  const notes = noteItems(offer?.notes ?? null);
  const close = () => useUi.setState({ updateDialog: null });
  const later = () => {
    if (version) dismiss(version);
    close();
  };
  return (
    <>
      <div className="text-lg font-semibold tracking-tight">Mr. Streamer {version}</div>
      <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">
        {channel === "nightly" ? "Nightly" : "Stable"}
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[0.875rem] text-foreground/85">
          {notes.slice(0, NOTE_LINES).map((item) => (
            <li key={item.text}>{item.text}</li>
          ))}
        </ul>
      )}
      {update.kind === "downloading" && (
        <div className="mt-4">
          <div className="h-1 overflow-hidden rounded-full bg-white/12">
            <div className="h-full bg-white" style={{ width: `${update.percent}%` }} />
          </div>
          <div className="mt-1.5 text-[0.8125rem] text-muted-foreground">
            Downloading · {update.percent} %
          </div>
        </div>
      )}
      {update.kind === "failed" && update.step !== "check" && (
        <p className="mt-3 text-sm text-destructive">{update.detail}</p>
      )}
      <div className="mt-5 flex items-center gap-2">
        {update.kind === "available" && (
          <>
            <Button variant="primary" size="sm" onClick={download}>
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={later}>
              Not now
            </Button>
          </>
        )}
        {update.kind === "downloading" && (
          <Button variant="secondary" size="sm" onClick={cancel}>
            Cancel
          </Button>
        )}
        {update.kind === "ready" && (
          <>
            <Button variant="primary" size="sm" onClick={restart}>
              Restart
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              Later
            </Button>
          </>
        )}
        {update.kind === "failed" && update.step !== "check" && (
          <Button variant="primary" size="sm" onClick={download}>
            Try again
          </Button>
        )}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ settings: "updates", updateDialog: null })}
          className="ml-auto text-[0.8125rem] text-muted-foreground hover:text-white"
        >
          Release notes ›
        </button>
      </div>
      {update.kind === "ready" && (
        <p className="mt-3 text-[0.8125rem] text-muted-foreground">
          Playback stops for a moment while Mr. Streamer restarts.
        </p>
      )}
    </>
  );
}
