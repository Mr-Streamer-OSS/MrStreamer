import type { Activation, GuideNative, Query, Result } from "../src/guide/guide-native.ts";

/** Linux lifecycle fixture, not a parser or a claim of native ingest support. */
export function guideFixture() {
  let next = 0;
  const activations = new Map<string, Activation>();
  const revoked = new Set<string>();

  const control = {
    activations,
    prepare: async (): Promise<Awaited<ReturnType<GuideNative["prepare"]>>> => ({
      kind: "failed",
      error: "unavailable",
    }),
    query: async (): Promise<Result<Query>> => ({
      kind: "ok",
      value: { guideId: null, rows: [], more: false },
    }),
  };

  const native: GuideNative = {
    async restore(ids, kept) {
      const restored = [];

      for (const [key, activation] of activations) {
        if (ids.includes(key) && !revoked.has(key)) restored.push(key);
        // Kept on disk unread, under a lease no one holds.
        else if (!ids.includes(key) && kept.some((prefix) => key.startsWith(prefix)))
          activations.set(key, { ...activation, lease: `l${++next}` });
        else activations.delete(key);
      }

      return restored.map((subscriptionId) => ({
        subscriptionId,
        activation: activations.get(subscriptionId)!,
      }));
    },
    async attach(id) {
      if (revoked.has(id)) throw new Error("disk");

      const activation = {
        lease: `l${++next}`,
        generation: activations.get(id)?.generation ?? null,
      };

      activations.set(id, activation);

      return activation;
    },
    revoke(id) {
      revoked.add(id);
    },
    async forget(id) {
      activations.delete(id);
      revoked.delete(id);

      return true;
    },
    begin(lease) {
      return [...activations].some(
        ([id, activation]) => !revoked.has(id) && activation.lease === lease,
      );
    },
    async cancel() {},
    async prepare() {
      return control.prepare();
    },
    async publish(lease) {
      const generation = {
        id: `db${++next}`,
        fetchedAt: Date.now(),
        until: Date.now() + 86400_000,
      };

      for (const [key, activation] of activations)
        if (activation.lease === lease) activations.set(key, { ...activation, generation });

      return { kind: "ok", value: generation };
    },
    async query() {
      return control.query();
    },
    async current() {
      return { kind: "ok", value: { ids: [] } };
    },
    async search() {
      return { kind: "ok", value: { rows: [] } };
    },
  };

  return { native, control };
}
