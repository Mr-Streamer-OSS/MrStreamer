// What Home and Live TV show while the channel list loads, when it fails, or when the provider
// lists no channels, with the one action that can help.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useUi } from "../app/ui-store.ts";
import { appError, describeError } from "../lib/errors.ts";
import { call } from "../lib/ipc.ts";
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

function Failed({ cause }: { cause: unknown }) {
  const client = useQueryClient();
  const error = appError(cause);
  const loginProblem = error.kind === "invalid-login" || error.kind === "account-inactive";
  return (
    <Notice title="Channels unavailable" message={describeError(error)}>
      {loginProblem ? (
        <Button variant="primary" onClick={() => useUi.setState({ editingLogin: true })}>
          Update login
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => void client.invalidateQueries({ queryKey: ["library"] })}
        >
          <RotateCw />
          Try again
        </Button>
      )}
    </Notice>
  );
}

function Empty() {
  // The empty list is cached, so checking again has to ask the provider.
  const refresh = useMutation({ mutationFn: () => call("library.refresh") });
  return (
    <Notice
      title="No live channels"
      message={
        refresh.error
          ? describeError(appError(refresh.error))
          : "Your provider lists no live channels right now."
      }
    >
      <Button variant="primary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        <RotateCw />
        {refresh.isPending ? "Checking…" : "Check again"}
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
