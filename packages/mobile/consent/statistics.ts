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
  let readable = true;
  let revoking = false;

  try {
    const saved = storage.load();

    if (saved?.choice === "on") record = saved;
    else if (saved?.choice === "off") record = { ...record, choice: "off" };
  } catch {
    available = false;
    readable = false;
  }

  const listeners = new Set<() => void>();

  function save(next: ConsentRecord<Event>): boolean {
    try {
      available = storage.save(next);
    } catch {
      available = false;
    }

    if (available) readable = true;

    // Refusal keeps the last known record; availability gates every delivery.
    record = available ? next : { ...record };

    for (const listener of listeners) listener();

    return available;
  }

  return {
    get: () => record,
    get readable() {
      return readable;
    },
    get pendingRevocation() {
      return revoking;
    },
    get available() {
      return available;
    },
    get enabled() {
      return available && !revoking && record.choice === "on";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    configure(enabled: boolean) {
      if (!enabled) revoking = true;

      if (revoking) {
        const held = save({ choice: "off", installationId: null, pending: [] });

        if (held) revoking = false;

        return held;
      }

      return save({ ...record, choice: "on" });
    },
    /** Removing the last provider keeps the choice but discards identity and unsent work. */
    discard() {
      if (!readable) return false;

      if (revoking) return this.configure(false);

      if (record.installationId === null && record.pending.length === 0) return available;

      return save({ ...record, installationId: null, pending: [] });
    },
    replace(next: ConsentRecord<Event>) {
      return record.choice === "on" && available && save(next);
    },
  };
}
