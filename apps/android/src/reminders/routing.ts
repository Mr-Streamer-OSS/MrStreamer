import { router, useRootNavigationState } from "expo-router";
import { useEffect, useState } from "react";
import { programmeHref } from "../guide/routes.ts";
import { nativeReminders } from "./native.ts";

function parseReminderTap(json: string) {
  try {
    const value: unknown = JSON.parse(json);

    if (
      typeof value !== "object" ||
      !value ||
      !("sourceId" in value) ||
      !("channelId" in value) ||
      !("start" in value)
    )
      return null;
    const { sourceId, channelId, start } = value;

    if (
      typeof sourceId !== "string" ||
      !sourceId ||
      typeof channelId !== "string" ||
      !channelId ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start <= 0
    )
      return null;

    return { sourceId, channelId, start };
  } catch {
    return null;
  }
}

/** Native extras bypass automatic URL routing, so cold and warm taps follow the same path. */
export function useReminderRouting(ready: boolean) {
  const navigation = useRootNavigationState();
  const [tap, setTap] = useState<ReturnType<typeof parseReminderTap>>(null);
  useEffect(() => {
    const native = nativeReminders();
    const accept = (json: string) => setTap(parseReminderTap(json));

    const consume = () =>
      native
        .takeTap()
        .then((json) => {
          if (json) accept(json);
        })
        .catch(() => {});

    const subscription = native.addListener("tap", () => {
      void consume();
    });

    void consume();

    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!ready || !navigation?.key || !tap) return;
    // Return the Live stack to its root before opening exactly one Programme above it.
    router.dismissTo("/");
    router.navigate(programmeHref("(live)", tap, tap.start), { withAnchor: true });
    setTap(null);
  }, [ready, navigation?.key, tap]);
}
