import type { Activation, GuideNative, Match, Query, Result } from "../src/guide-native.ts";

/** Linux lifecycle fixture, not a parser or a claim of native ingest support. */
export function guideFixture() {
  let next = 0;
  const activations = new Map<string, Activation>();
  const revoked = new Set<string>();
  const calls: string[] = [];
  const refused = new Set<string>();
  const cancelled = new Set<string>();
  const control = {
    calls,
    refused,
    cancelled,
    activations,
    prepare: async (): Promise<Awaited<ReturnType<GuideNative["prepare"]>>> => ({
      kind: "failed",
      error: "unavailable",
    }),
    query: async (): Promise<Result<Query>> => ({
      kind: "ok",
      value: { guideId: null, rows: [], more: false },
    }),
    current: async (): Promise<Result<{ readonly ids: readonly string[] }>> => ({
      kind: "ok",
      value: { ids: [] },
    }),
    search: async (): Promise<Result<{ readonly rows: readonly Match[] }>> => ({
      kind: "ok",
      value: { rows: [] },
    }),
    forget: async (_id: string) => true,
  };
  const native: GuideNative = {
    async restore(ids, kept) {
      calls.push(`restore:${ids.join(",")}`);
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
    async attach(id, revision) {
      calls.push(`attach:${id}:${revision}`);
      if (revoked.has(id)) throw new Error("disk");
      const activation = {
        lease: `l${++next}`,
        generation: activations.get(id)?.generation ?? null,
      };
      activations.set(id, activation);
      return activation;
    },
    revoke(id) {
      calls.push(`revoke:${id}`);
      revoked.add(id);
    },
    async forget(id) {
      calls.push(`forget:${id}`);
      if (refused.has(id) || !(await control.forget(id))) return false;
      activations.delete(id);
      revoked.delete(id);
      return true;
    },
    begin(lease, job) {
      calls.push(`begin:${job}`);
      return [...activations].some(
        ([id, activation]) => !revoked.has(id) && activation.lease === lease,
      );
    },
    async cancel(job) {
      cancelled.add(job);
    },
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
      return control.current();
    },
    async search() {
      return control.search();
    },
  };
  return { native, control };
}

const host: { expo?: { modules?: { Guide?: GuideNative } } } = globalThis;
host.expo ??= {};
host.expo.modules ??= {};
host.expo.modules.Guide ??= guideFixture().native;
