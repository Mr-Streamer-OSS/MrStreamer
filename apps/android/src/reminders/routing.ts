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
      !("start" in value) ||
      !("stop" in value)
    )
      return null;
    const { sourceId, channelId, start, stop } = value;

    if (
      typeof sourceId !== "string" ||
      !sourceId ||
      typeof channelId !== "string" ||
      !channelId ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start <= 0 ||
      typeof stop !== "number" ||
      !Number.isFinite(stop) ||
      stop <= start
    )
      return null;

    return { sourceId, channelId, start, stop };
  } catch {
    return null;
  }
}

/** Native extras bypass automatic URL routing, so cold and warm taps follow the same path. */
export function useReminderRouting(ready: boolean, empty = false) {
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
    if (!tap) return;

    if (empty || tap.stop <= Date.now()) {
      setTap(null);

      return;
    }

    if (!ready || !navigation?.key) return;
    // Return the Live stack to its root before opening exactly one Programme above it.
    router.dismissTo("/");
    router.navigate(programmeHref("(live)", tap, tap.start), { withAnchor: true });
    setTap(null);
  }, [ready, empty, navigation?.key, tap]);
}
