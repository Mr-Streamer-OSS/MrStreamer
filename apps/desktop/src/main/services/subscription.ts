// The one connected subscription: validated with the provider, stored with a sealed password, or
// for a playlist, a sealed link.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type } from "arktype";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { Provider, ProviderOptions } from "@mrstreamer/core/provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import type { Secrets } from "../platform/secrets.ts";
import { providerFor, type ProviderAccount } from "../providers/account.ts";
import { httpsUnavailable, parseLogin } from "../providers/xtream.ts";

const AccountRecord = type({
  state: "'active' | 'expired' | 'banned' | 'disabled' | 'unknown'",
  expiresAt: "string | null",
  maxConnections: "number | null",
  activeConnections: "number | null",
});

// A playlist is a kind releases before it don't know: they read the file as no subscription, show
// Connect and leave the file alone until another login replaces it.
const StoredSubscription = type({
  version: "1",
  kind: "'xtream'",
  server: "string",
  username: "string",
  sealedPassword: "string",
  account: AccountRecord,
}).or({
  version: "1",
  kind: "'m3u'",
  /** Where the playlist comes from, to show: its origin. The link itself is sealed. */
  server: "string",
  /** Tells playlists apart without the link: `m3u:` and part of the link's SHA-256. */
  key: "string",
  sealedLink: "string",
  account: AccountRecord,
});
type StoredSubscription = typeof StoredSubscription.infer;

/** The connected subscription as other services use it. `key` changes when the login does. */
export interface Source {
  readonly key: string;
  readonly provider: Provider;
  /** The login or link itself, for a worker thread that builds its own copy of the provider. */
  readonly account: ProviderAccount;
}

interface Provided {
  readonly provider: Provider;
  readonly account: ProviderAccount;
}

interface Connected {
  readonly stored: StoredSubscription;
  /**
   * Null when the saved password or link cannot be read any more; the user has to enter it
   * again.
   */
  readonly provider: Provided | null;
}

export interface SubscriptionDeps {
  readonly dataDir: string;
  readonly secrets: Secrets;
  readonly providerOptions: ProviderOptions;
}

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly get: Effect.Effect<SubscriptionSummary | null>;
    /**
     * Checks the login with the provider, then stores it. Replaces any earlier subscription. An
     * address without a scheme connects over https or fails with `unencrypted-only`.
     */
    connect(login: LoginInput): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Asks the provider for the latest account status (expiry, connections) and stores it,
     * unless the subscription was removed or replaced while the provider answered.
     */
    readonly recheck: Effect.Effect<SubscriptionSummary | null, Failed>;
    readonly remove: Effect.Effect<void>;
    /** The provider behind the subscription, or null without one or its password. */
    readonly source: Effect.Effect<Source | null>;
    /**
     * The subscription's `Source.key`, also while its password can't be read: what its viewing
     * record is kept under. Null without a subscription.
     */
    readonly key: Effect.Effect<string | null>;
  }
>()("mrstreamer/Subscriptions") {
  static readonly layer = (deps: SubscriptionDeps) => Layer.effect(Subscriptions, make(deps));
}

function make(deps: SubscriptionDeps) {
  return Effect.gen(function* () {
    const path = join(deps.dataDir, "subscription.json");
    let current: Promise<Connected | null> | null = null;
    /** Counts logins and removals, so a login that finishes late cannot undo a newer one. */
    let changes = 0;
    /**
     * Storage changes run one at a time. Provider requests happen before, so each change checks
     * that it still applies and a slow answer never overwrites a newer state.
     */
    const writeOne = (yield* Semaphore.make(1)).withPermits(1);

    const load = Effect.promise(() => {
      current ??= readJsonFile(path, StoredSubscription).then((stored) => {
        if (!stored) return null;
        try {
          return { stored, provider: connected(stored, deps.secrets.open(sealedOf(stored))) };
        } catch {
          // A new signature, a reset keychain or a denied prompt all end here.
          return { stored, provider: null };
        }
      });
      return current;
    });

    /** The provider of a stored subscription, from its password or link `secret`. */
    function connected(stored: StoredSubscription, secret: string): Provided {
      const account: ProviderAccount =
        stored.kind === "xtream"
          ? { kind: "xtream", server: stored.server, username: stored.username, password: secret }
          : { kind: "m3u", link: secret };
      return { provider: providerFor(account, deps.providerOptions), account };
    }

    /** Stores the subscription and keeps `provided`, which holds what a playlist read last. */
    const save = (stored: StoredSubscription, provided: Provided) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeJsonFile(path, stored));
        const next = { stored, provider: provided };
        current = Promise.resolve(next);
        return summary(next);
      });

    return {
      get: Effect.map(load, (subscription) => (subscription ? summary(subscription) : null)),

      connect: (login: LoginInput) =>
        Effect.gen(function* () {
          const change = ++changes;
          const { account, schemeless } = yield* Effect.try({
            try: () => parseLogin(login),
            catch: failedWith,
          });
          const provider = providerFor(account, deps.providerOptions);
          const status = yield* Effect.tryPromise({
            try: (signal) => provider.authenticate(signal),
            catch: failedWith,
          }).pipe(
            // An address typed without a scheme goes to http only once the viewer agrees: the
            // login would travel unencrypted. A playlist without a login keeps the https answer.
            Effect.mapError((failed) =>
              account.kind === "xtream" && schemeless && httpsUnavailable(failed.error)
                ? new Failed({ error: { kind: "unencrypted-only", server: account.server } })
                : failed,
            ),
          );
          // The link of a playlist can hold a token, so it is sealed like a password.
          const sealed = yield* Effect.try({
            try: () =>
              deps.secrets.seal(account.kind === "xtream" ? account.password : account.link),
            catch: failedWith,
          });
          const stored: StoredSubscription =
            account.kind === "xtream"
              ? {
                  version: 1,
                  kind: "xtream",
                  server: account.server,
                  username: account.username,
                  sealedPassword: sealed,
                  account: status,
                }
              : {
                  version: 1,
                  kind: "m3u",
                  server: new URL(account.link).origin,
                  key: `m3u:${createHash("sha256").update(account.link).digest("hex").slice(0, 16)}`,
                  sealedLink: sealed,
                  account: status,
                };
          return yield* writeOne(
            Effect.gen(function* () {
              if (change !== changes) {
                return yield* new Failed({
                  error: {
                    kind: "unexpected",
                    detail: "The subscription changed while this login was being checked.",
                  },
                });
              }
              return yield* save(stored, { provider, account });
            }),
          );
        }).pipe(diagnosed("connect")),

      recheck: Effect.gen(function* () {
        const subscription = yield* load;
        const provided = subscription?.provider;
        if (!subscription || !provided) return subscription ? summary(subscription) : null;
        const account = yield* Effect.tryPromise({
          try: (signal) => provided.provider.authenticate(signal),
          catch: failedWith,
        });
        return yield* writeOne(
          Effect.gen(function* () {
            const latest = yield* load;
            if (latest !== subscription) return latest ? summary(latest) : null;
            return yield* save({ ...subscription.stored, account }, provided);
          }),
        );
      }),

      remove: Effect.gen(function* () {
        changes++;
        yield* writeOne(
          Effect.promise(async () => {
            current = Promise.resolve(null);
            await removeFile(path);
          }),
        );
      }),

      source: Effect.map(load, (subscription): Source | null =>
        subscription?.provider
          ? { key: keyOf(subscription.stored), ...subscription.provider }
          : null,
      ),

      key: Effect.map(load, (subscription) => (subscription ? keyOf(subscription.stored) : null)),
    };
  });
}

function summary({ stored, provider }: Connected): SubscriptionSummary {
  return {
    kind: stored.kind,
    id: keyOf(stored),
    server: stored.server,
    username: stored.kind === "xtream" ? stored.username : "",
    account: stored.account,
    needsPassword: provider === null,
  };
}

/**
 * Identifies the account, and changes when the login does: the server and the username, or a
 * playlist's fingerprint. Its caches and its viewing record are kept under it.
 */
function keyOf(stored: StoredSubscription): string {
  return stored.kind === "xtream" ? `${stored.server}|${stored.username}` : stored.key;
}

function sealedOf(stored: StoredSubscription): string {
  return stored.kind === "xtream" ? stored.sealedPassword : stored.sealedLink;
}
