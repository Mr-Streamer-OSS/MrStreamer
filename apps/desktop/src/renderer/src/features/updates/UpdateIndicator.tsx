// A quiet status in the top bar while an update downloads or waits, so it can be seen without
// opening Settings.
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { useUpdates } from "./use-updates.ts";

export function UpdateIndicator({ overlay }: { overlay: boolean }) {
  const { status } = useUpdates();
  if (!status) return null;
  const { update } = status;
  const quiet = overlay ? "media" : "ghost";
  const openSettings = () => useUi.setState({ settings: "updates" });

  if (update.kind === "downloading") {
    return (
      <Button variant={quiet} size="sm" onClick={openSettings}>
        Updating · {update.percent} %
      </Button>
    );
  }
  if (update.kind === "ready") {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => useUi.setState({ updateDialog: "restart" })}
      >
        Restart to update
      </Button>
    );
  }
  return null;
}
