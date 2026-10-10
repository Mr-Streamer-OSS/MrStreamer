// What Home and Live TV show while the channel list loads, when it fails, or when the provider
// lists no channels, with the one action that can help.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@mrstreamer/core/i18n";
import { openSubscription, useUi } from "../app/ui-store.ts";
import { appError, describeError } from "../lib/errors.ts";
import { call } from "../lib/ipc.ts";
import { subscriptionName, useSubscriptions } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";

export type CatalogueState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly cause: unknown }
  | { readonly kind: "empty" };

/** The state to show instead of channels, or null once there are channels. */
export function catalogueState(query: {
  readonly data: readonly unknown[] | undefined;
  readonly error: unknown;
}): CatalogueState | null {
  if (query.error) return { kind: "failed", cause: query.error };
  if (!query.data) return { kind: "loading" };
  return query.data.length === 0 ? { kind: "empty" } : null;
}

export function CatalogueNotice({ state }: { state: CatalogueState }) {
  if (state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading channels…</p>;
  }
  return state.kind === "failed" ? <Failed cause={state.cause} /> : <Empty />;
}

/**
 * No subscription has channels to show. With one that needs its password or link again, or whose
 * login the provider refused, the way on is its row in Settings.
 */
function Failed({ cause }: { cause: unknown }) {
  const client = useQueryClient();
  const subscriptions = useSubscriptions();
  const error = appError(cause);
  const locked =
    error.kind === "needs-secret"
      ? subscriptions.find((each) => each.id === error.subscriptionId)
      : undefined;
  const loginProblem = error.kind === "invalid-login" || error.kind === "account-inactive";
  return (
    <Notice
      title={t("Channels unavailable")}
      message={
        locked
          ? locked.kind === "m3u"
            ? t("{name} needs its link again.", { name: subscriptionName(locked) })
            : t("{name} needs its password again.", { name: subscriptionName(locked) })
          : describeError(error)
      }
    >
      {locked ? (
        <Button variant="primary" onClick={() => openSubscription(locked.id, "secret")}>
          {locked.kind === "m3u" ? t("Enter link") : t("Enter password")}
        </Button>
      ) : loginProblem ? (
        <Button variant="primary" onClick={() => useUi.setState({ settings: "subscriptions" })}>
          {t("Update login")}
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => void client.invalidateQueries({ queryKey: ["library"] })}
        >
          <RotateCw />
          {t("Try again")}
        </Button>
      )}
    </Notice>
  );
}

function Empty() {
  const subscriptions = useSubscriptions();
  // The empty lists are cached, so checking again has to ask the providers.
  const refresh = useMutation({
    mutationFn: () =>
      Promise.all(subscriptions.map(({ id }) => call("library.refresh", { subscriptionId: id }))),
  });
  return (
    <Notice
      title={t("No live channels")}
      message={
        refresh.error
          ? describeError(appError(refresh.error))
          : t("Your provider lists no live channels right now.")
      }
    >
      <Button variant="primary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        <RotateCw />
        {refresh.isPending ? t("Checking…") : t("Check again")}
      </Button>
    </Notice>
  );
}

function Notice({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex max-w-[32rem] flex-col items-center px-8 text-center">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{message}</p>
      <div className="mt-7">{children}</div>
    </div>
  );
}
