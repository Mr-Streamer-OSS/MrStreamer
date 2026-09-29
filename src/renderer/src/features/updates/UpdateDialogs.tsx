// The confirmations around updates: restarting into a downloaded update, and the two steps of
// starting fresh on Stable. Erasing needs its own tick, right before it happens.
import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";
import { useUpdates } from "./use-updates.ts";

export function UpdateDialogs() {
  const dialog = useUi((state) => state.updateDialog);
  const { status, run } = useUpdates();
  const close = () => useUi.setState({ updateDialog: null });

  // The final step opens once Stable is downloaded: the user asked for it moments before.
  const freshKind = status?.fresh.kind;
  useEffect(() => {
    if (freshKind === "ready") useUi.setState({ updateDialog: "erase", settingsOpen: false });
  }, [freshKind]);

  const update = status?.update;
  const fresh = status?.fresh;
  return (
    <>
      <Modal open={dialog === "restart"} onClose={close} title="Restart to update?">
        <p>
          Playback stops and Mr. Streamer reopens on{" "}
          {update?.kind === "ready" ? update.version : "the new version"}.
        </p>
        <Actions>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void call("updates.restart");
            }}
          >
            Restart now
          </Button>
          <Button variant="ghost" onClick={close}>
            Later
          </Button>
        </Actions>
      </Modal>

      <Modal open={dialog === "fresh"} onClose={close} title="Start fresh on Stable?">
        <p>
          Mr. Streamer downloads the newest stable release first. Nothing is erased until you
          confirm again.
        </p>
        <Actions>
          <Button
            variant="primary"
            onClick={() => {
              close();
              run("updates.prepareFresh");
            }}
          >
            Download Stable
          </Button>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </Actions>
      </Modal>

      <EraseDialog
        open={dialog === "erase"}
        version={fresh?.kind === "ready" ? fresh.version : null}
        onKeep={() => {
          close();
          run("updates.keepEverything");
        }}
        onClose={close}
      />
    </>
  );
}

function EraseDialog({
  open,
  version,
  onKeep,
  onClose,
}: {
  open: boolean;
  version: string | null;
  onKeep: () => void;
  onClose: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  useEffect(() => {
    if (!open) setUnderstood(false);
  }, [open]);
  return (
    <Modal
      open={open && version !== null}
      onClose={onClose}
      title={`Erase and install Stable ${version}?`}
    >
      <p>Stable {version} is downloaded and checked. Restarting erases this device's:</p>
      <ul className="mt-2 list-disc pl-5">
        <li>subscription login</li>
        <li>preferences</li>
        <li>watch history</li>
        <li>channel list</li>
      </ul>
      <p className="mt-3">
        You'll connect your subscription again. Your provider account and other devices aren't
        affected.
      </p>
      <label className="mt-4 flex items-center gap-2.5">
        <Checkbox.Root
          checked={understood}
          onCheckedChange={setUnderstood}
          className="grid size-4 flex-none place-items-center rounded-[4px] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/55%)] outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
        >
          <Checkbox.Indicator className="text-black">
            <Check className="size-3" strokeWidth={3} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        I understand this can't be undone
      </label>
      <Actions>
        <Button
          variant="destructive"
          disabled={!understood}
          onClick={() => {
            onClose();
            void call("updates.startFresh");
          }}
        >
          Erase and restart
        </Button>
        <Button variant="ghost" onClick={onKeep}>
          Keep everything
        </Button>
      </Actions>
    </Modal>
  );
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/70 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-[60] w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[1.25rem] bg-popover p-6 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <Dialog.Title className="mb-2 text-lg font-semibold tracking-tight">{title}</Dialog.Title>
          <div className="text-muted-foreground [&_p]:text-[0.9375rem]">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex gap-3">{children}</div>;
}
