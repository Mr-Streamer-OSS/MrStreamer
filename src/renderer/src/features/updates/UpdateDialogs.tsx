// The confirmation before restarting into a downloaded update.
import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";
import { useUpdates } from "./use-updates.ts";

/**
 * Installs and restarts. The call only settles when the app is still running, because the
 * release was refused or the install couldn't start; Settings then shows why.
 */
function restart(): void {
  const showSettings = () => useUi.setState({ settingsOpen: true });
  call("updates.restart").then(showSettings, showSettings);
}

export function UpdateDialogs() {
  const dialog = useUi((state) => state.updateDialog);
  const { status } = useUpdates();
  const close = () => useUi.setState({ updateDialog: null });
  const update = status?.update;
  return (
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
            restart();
          }}
        >
          Restart now
        </Button>
        <Button variant="ghost" onClick={close}>
          Later
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
