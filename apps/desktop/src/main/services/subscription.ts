// The one connected subscription: validated with the provider, stored with a sealed password.
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
import { parseLogin, xtreamProvider, type XtreamAccount } from "../providers/xtream.ts";

const StoredSubscription = type({
  version: "1",
  kind: "'xtream'",
  server: "string",
  username: "string",
  sealedPassword: "string",
  account: {
    state: "'active' | 'expired' | 'banned' | 'disabled' | 'unknown'",
    expiresAt: "string | null",
    maxConnections: "number | null",
    activeConnections: "number | null",
  },
});
type StoredSubscription = typeof StoredSubscription.infer;

/** The connected subscription as other services use it. `key` changes when the login does. */
export interface Source {
  readonly key: string;
  readonly provider: Provider;
  /** The login itself, for a worker thread that builds its own copy of the provider. */
  readonly account: XtreamAccount;
}

interface Connected {
  readonly stored: StoredSubscription;
  /** Null when the saved password cannot be read any more; the user has to enter it again. */
  readonly provider: { readonly provider: Provider; readonly account: XtreamAccount } | null;
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
    /** Checks the login with the provider, then stores it. Replaces any earlier subscription. */
    connect(login: LoginInput): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Asks the provider for the latest account status (expiry, connections) and stores it,
     * unless the subscription was removed or replaced while the provider answered.
     */
    readonly recheck: Effect.Effect<SubscriptionSummary | null, Failed>;
    readonly remove: Effect.Effect<void>;
    /** The provider behind the subscription, or null without one or its password. */
    readonly source: Effect.Effect<Source | null>;
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
          return connected(stored, deps.secrets.open(stored.sealedPassword));
        } catch {
          // A new signature, a reset keychain or a denied prompt all end here.
          return { stored, provider: null };
        }
      });
      return current;
    });

    function connected(stored: StoredSubscription, password: string): Connected {
      const account = { server: stored.server, username: stored.username, password };
      return {
        stored,
        provider: { provider: xtreamProvider(account, deps.providerOptions), account },
      };
    }

    const save = (stored: StoredSubscription, password: string) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeJsonFile(path, stored));
        const next = connected(stored, password);
        current = Promise.resolve(next);
        return summary(next);
      });

    return {
      get: Effect.map(load, (subscription) => (subscription ? summary(subscription) : null)),

      connect: (login: LoginInput) =>
        Effect.gen(function* () {
          const change = ++changes;
          const account = yield* Effect.try({ try: () => parseLogin(login), catch: failedWith });
          const status = yield* Effect.tryPromise({
            try: (signal) => xtreamProvider(account, deps.providerOptions).authenticate(signal),
            catch: failedWith,
          });
          const sealedPassword = yield* Effect.try({
            try: () => deps.secrets.seal(account.password),
            catch: failedWith,
          });
          const stored: StoredSubscription = {
            version: 1,
            kind: "xtream",
            server: account.server,
            username: account.username,
            sealedPassword,
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
              return yield* save(stored, account.password);
            }),
          );
        }).pipe(diagnosed("connect")),

      recheck: Effect.gen(function* () {
        const subscription = yield* load;
        const provider = subscription?.provider?.provider;
        if (!subscription || !provider) return subscription ? summary(subscription) : null;
        const account = yield* Effect.tryPromise({
          try: (signal) => provider.authenticate(signal),
          catch: failedWith,
        });
        return yield* writeOne(
          Effect.gen(function* () {
            const latest = yield* load;
            if (latest !== subscription) return latest ? summary(latest) : null;
            const password = yield* Effect.try({
              try: () => deps.secrets.open(subscription.stored.sealedPassword),
              catch: failedWith,
            });
            return yield* save({ ...subscription.stored, account }, password);
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

      source: Effect.map(load, (subscription): Source | null => {
        if (!subscription?.provider) return null;
        const { server, username } = subscription.stored;
        return { key: `${server}|${username}`, ...subscription.provider };
      }),
    };
  });
}

function summary({ stored, provider }: Connected): SubscriptionSummary {
  return {
    kind: stored.kind,
    server: stored.server,
    username: stored.username,
    account: stored.account,
    needsPassword: provider === null,
  };
}
