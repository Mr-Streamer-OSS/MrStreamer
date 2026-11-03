import { store } from "../platform/store.ts";

export interface ScheduleIntent {
  readonly kind: "schedule";
  readonly sourceId: string;
  readonly channelId: string;
}

interface Handlers {
  readonly schedule?: (intent: ScheduleIntent) => void;
}

export const intentHandlers = store<Handlers>({});

/** Consumer-owned registration. No handler is installed by Live itself. */
export function registerLiveHandlers(handlers: Handlers) {
  intentHandlers.set(handlers);

  return () => {
    if (intentHandlers.get() === handlers) intentHandlers.set({});
  };
}
