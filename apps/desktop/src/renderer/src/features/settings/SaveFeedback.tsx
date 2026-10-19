import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";

/** Feedback stays beside the action that failed. Retrying sends the same intended value. */
export function SaveFeedback({
  pending,
  error,
  retry,
  retryDisabled = false,
}: {
  pending: boolean;
  error: unknown;
  retry: () => void;
  retryDisabled?: boolean;
}) {
  if (pending)
    return (
      <p role="status" className="py-2 text-sm">
        {t("Saving…")}
      </p>
    );
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span>{describeError(appError(error))}</span>
      <Button size="sm" variant="ghost" disabled={retryDisabled} onClick={retry}>
        {t("Try again")}
      </Button>
    </div>
  );
}
