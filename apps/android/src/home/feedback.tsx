import { Dialog, TextButton } from "../live/chrome.tsx";
import { useStore } from "../platform/store.ts";
import { t } from "./copy.ts";
import { acknowledgeProgress, viewingFailure } from "./index.ts";

/**
 * iOS's dialog for a refused progress save, on the screens Home owns: nothing was saved, and OK
 * closes it. It shows once until a later save is kept.
 */
export function ProgressDialog() {
  const failure = useStore(viewingFailure);

  return (
    <Dialog
      visible={failure?.kind === "progress"}
      title={t("Couldn't save progress")}
      body={t("Your latest position could not be saved.")}
      onClose={acknowledgeProgress}
      actions={<TextButton label={t("OK")} strong onPress={acknowledgeProgress} />}
    />
  );
}
