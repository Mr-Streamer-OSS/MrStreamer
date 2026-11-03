export type Choice = "on" | "off" | null;

export interface ConsentRecord<Event> {
  readonly choice: Choice;
  readonly installationId: string | null;
  readonly pending: readonly Event[];
}

export interface ConsentStorage<Event> {
  load(): ConsentRecord<Event> | null;
  save(record: ConsentRecord<Event>): boolean;
}

/** One deliberate choice; unavailable storage never grants consent. Off forgets unsent work. */
export function statisticsConsent<Event>(storage: ConsentStorage<Event>) {
  let record: ConsentRecord<Event> = { choice: null, installationId: null, pending: [] };
  let available = true;

  try {
    const saved = storage.load();

    if (saved?.choice === "on") record = saved;
    else if (saved?.choice === "off") record = { ...record, choice: "off" };
  } catch {
    available = false;
  }

  const listeners = new Set<() => void>();

  function save(next: ConsentRecord<Event>): boolean {
    try {
      available = storage.save(next);
    } catch {
      available = false;
    }

    // On failure keep no in-memory identity or outbox eligible for later delivery.
    record = available ? next : { choice: null, installationId: null, pending: [] };

    for (const listener of listeners) listener();

    return available;
  }

  return {
    get: () => record,
    get available() {
      return available;
    },
    get enabled() {
      return available && record.choice === "on";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    configure(enabled: boolean) {
      return save(
        enabled
          ? { ...record, choice: "on" }
          : { choice: "off", installationId: null, pending: [] },
      );
    },
    /** Removing the last provider keeps the choice but discards identity and unsent work. */
    discard() {
      return save({ ...record, installationId: null, pending: [] });
    },
    replace(next: ConsentRecord<Event>) {
      return record.choice === "on" && available && save(next);
    },
  };
}
