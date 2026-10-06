// The saved subscription: validated with the provider, stored with a sealed password, or for a
// playlist, a sealed link.
//
// Two files hold it. subscription.json is the login as every release has kept it, and the newest
// stable release still reads and writes it: it stays the only place for the login, its sealed
// secret and the account's status. subscriptions.json, the registry, lists the saved subscriptions
// and gives each the id the rest of the app names it by. The entry marked `original` is the one
// whose login subscription.json holds; it keeps the account that id was given to, as its server
// and username or a playlist's fingerprint, and never the password or a playlist's link. This
// build reads and writes that entry alone, and leaves any other as it found it.
//
// The two are written one after the other, and a stable release changes the first without the
// second. So each start settles them, with subscription.json deciding (see `settle`): the same
// account keeps its id, another account gets a new one, and a login that is gone takes its entry
// with it. Nothing else is touched: what the account loaded and what the viewer kept stay under
// the account's own key, where every release finds them.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { type } from "arktype";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountStatus, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
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
import {
  connectionIgnored,
  httpsUnavailable,
  parseLogin,
  type TcpConnect,
} from "../providers/xtream.ts";

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

/** The registry's entry for the subscription whose login subscription.json holds. */
const OriginalEntry = type({
  /** What the app names the subscription by: made up once, and never the login. */
  id: "string > 0",
  original: "true",
  /** The account the id was given to, as `keyOf` names it. Another account gets another id. */
  key: "string",
});
type OriginalEntry = typeof OriginalEntry.infer;

/** subscriptions.json. Entries are read one by one, so one this build can't read costs no other. */
const Registry = type({ version: "1", subscriptions: "object[]" });

/** The saved subscription as other services use it. */
export interface Source {
  /** What channels, titles and requests name the subscription by. */
  readonly id: string;
  /**
   * Rises each time its login or secret is stored or read anew. What was asked of the provider
   * under an earlier one doesn't count for this one.
   */
  readonly revision: number;
  /**
   * The account: the server and username, or a playlist's fingerprint. Its caches and its viewing
   * record are kept under it, where other releases find them. It changes when the login does.
   */
  readonly key: string;
  readonly provider: Provider;
  /** The login or link itself, for a worker thread that builds its own copy of the provider. */
  readonly account: ProviderAccount;
}

/**
 * Whether `other` is `source` with the login or link it had then. What was asked of a provider
 * counts only while this holds: not once its subscription went, nor after its login changed.
 */
export function sameSource(source: Source, other: Source | null | undefined): boolean {
  return other?.id === source.id && other.revision === source.revision;
}

interface Provided {
  readonly provider: Provider;
  readonly account: ProviderAccount;
}

interface Connected {
  readonly id: string;
  readonly revision: number;
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
  /** Opens the connection that tries an address's https port. `net.connect`, except in tests. */
  readonly tcpConnect?: TcpConnect;
}

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly get: Effect.Effect<SubscriptionSummary | null>;
    /**
     * Checks the login with the provider, then stores it. Replaces any earlier subscription: the
     * same account keeps its id, another gets a new one. An address without a scheme connects
     * over https or fails with `unencrypted-only`.
     */
    connect(login: LoginInput): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Asks the provider for the latest account status (expiry, connections) and stores it,
     * unless the subscription was removed or replaced while the provider answered.
     */
    readonly recheck: Effect.Effect<SubscriptionSummary | null, Failed>;
    readonly remove: Effect.Effect<void>;
    /** The provider behind the subscription, or null without one or its password or link. */
    readonly source: Effect.Effect<Source | null>;
    /**
     * The source of the subscription a request names. Fails with `no-subscription` when that one
     * isn't saved, as after it was removed or another took its place, or has no password or link.
     */
    sourceOf(subscriptionId: string): Effect.Effect<Source, Failed>;
    /**
     * The subscription's `Source.key`, also while its password or link can't be read: what its
     * viewing record is kept under. Null without a subscription.
     */
    readonly key: Effect.Effect<string | null>;
  }
>()("mrstreamer/Subscriptions") {
  static readonly layer = (deps: SubscriptionDeps) => Layer.effect(Subscriptions, make(deps));
}

function make(deps: SubscriptionDeps) {
  return Effect.gen(function* () {
    const path = join(deps.dataDir, "subscription.json");
    const registryPath = join(deps.dataDir, "subscriptions.json");
    let current: Promise<Connected | null> | null = null;
    /** Counts logins and removals, so a login that finishes late cannot undo a newer one. */
    let changes = 0;
    /** Counts the logins and secrets stored or read, for `Source.revision`. */
    let revisions = 0;
    /**
     * Storage changes run one at a time. Provider requests happen before, so each change checks
     * that it still applies and a slow answer never overwrites a newer state.
     */
    const writeOne = (yield* Semaphore.make(1)).withPermits(1);

    /**
     * Sets or replaces the original's entry in the registry, or drops it with null. Every other
     * entry stays as the file holds it, in its place.
     */
    const writeOriginal = async (entry: OriginalEntry | null) => {
      const { entries, at } = await readRegistry(registryPath);
      const rest = entries.filter((_, index) => index !== at);
      const subscriptions = !entry ? rest : at === -1 ? [...rest, entry] : entries.with(at, entry);
      await writeJsonFile(registryPath, { version: 1, subscriptions });
    };

    /**
     * What the two files hold, made to agree, with subscription.json deciding: it is what a
     * stable release changes, and what a write cut short leaves ahead of the registry. The
     * account the registry knows keeps its id; a first start with the registry, another account
     * and a registry that can't be read get a new one; a login that is gone takes its entry.
     */
    const settle = async (): Promise<Connected | null> => {
      const [stored, { original }] = await Promise.all([
        readJsonFile(path, StoredSubscription),
        readRegistry(registryPath),
      ]);
      const entry: OriginalEntry | null = !stored
        ? null
        : original?.key === keyOf(stored)
          ? original
          : { id: randomUUID(), original: true, key: keyOf(stored) };
      if (entry !== original) {
        // The id holds for this run either way; a registry that can't be written gets another.
        await writeOriginal(entry).catch((cause: unknown) =>
          console.warn(`[storage] can't write ${registryPath}`, cause),
        );
      }
      if (!stored || !entry) return null;
      const revision = ++revisions;
      try {
        const provider = connected(stored, deps.secrets.open(sealedOf(stored)));
        return { id: entry.id, revision, stored, provider };
      } catch {
        // A new signature, a reset keychain or a denied prompt all end here.
        return { id: entry.id, revision, stored, provider: null };
      }
    };

    const load = Effect.promise(() => (current ??= settle()));

    /** The provider of a stored subscription, from its password or link `secret`. */
    function connected(stored: StoredSubscription, secret: string): Provided {
      const account: ProviderAccount =
        stored.kind === "xtream"
          ? { kind: "xtream", server: stored.server, username: stored.username, password: secret }
          : { kind: "m3u", link: secret };
      return { provider: providerFor(account, deps.providerOptions), account };
    }

    /**
     * Stores the subscription and keeps `provider`, which holds what a playlist read last. The
     * login goes first: a write cut short after it leaves what the next start settles.
     */
    const save = (next: Connected, previous: Connected | null) =>
      Effect.promise(async () => {
        await writeJsonFile(path, next.stored);
        if (next.id !== previous?.id) {
          await writeOriginal({ id: next.id, original: true, key: keyOf(next.stored) });
        }
        current = Promise.resolve(next);
        return summary(next);
      });

    /**
     * The login check `authenticated` for an https address the viewer typed without a scheme.
     * When https is what fails there, it fails with `unencrypted-only` instead. A port that leaves
     * the connection unanswered ends it that way within seconds (`connectionIgnored`). A server
     * that accepted the connection keeps the whole time a login gets.
     */
    const httpsOrAsk = (authenticated: Effect.Effect<AccountStatus, Failed>, server: string) => {
      const ask = new Failed({ error: { kind: "unencrypted-only", server } });
      return authenticated.pipe(
        Effect.mapError((failed) => (httpsUnavailable(failed.error) ? ask : failed)),
        Effect.raceFirst(
          Effect.promise((signal) => connectionIgnored(server, signal, deps.tcpConnect)).pipe(
            Effect.flatMap((ignored) => (ignored ? Effect.fail(ask) : Effect.never)),
          ),
        ),
      );
    };

    const source = Effect.map(load, (subscription): Source | null =>
      subscription?.provider
        ? {
            id: subscription.id,
            revision: subscription.revision,
            key: keyOf(subscription.stored),
            ...subscription.provider,
          }
        : null,
    );

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
          const authenticated = Effect.tryPromise({
            try: (signal) => provider.authenticate(signal),
            catch: failedWith,
          });
          // An address typed without a scheme goes to http only once the viewer agrees: the
          // login would travel unencrypted. A playlist without a login keeps the https answer.
          const status = yield* account.kind === "xtream" && schemeless
            ? httpsOrAsk(authenticated, account.server)
            : authenticated;
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
              const previous = yield* load;
              // The same account keeps its id: what the app names by it still means it.
              const kept = previous && keyOf(previous.stored) === keyOf(stored);
              return yield* save(
                {
                  id: kept ? previous.id : randomUUID(),
                  revision: ++revisions,
                  stored,
                  provider: { provider, account },
                },
                previous,
              );
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
            const stored = { ...subscription.stored, account };
            return yield* save({ ...subscription, stored }, subscription);
          }),
        );
      }),

      remove: Effect.gen(function* () {
        changes++;
        yield* writeOne(
          Effect.gen(function* () {
            // Settled first, so nothing a start still writes comes after the removal.
            yield* load;
            yield* Effect.promise(async () => {
              current = Promise.resolve(null);
              // The sealed password or link first, then the id that named its subscription.
              await removeFile(path);
              await writeOriginal(null);
            });
          }),
        );
      }),

      source,

      sourceOf: (subscriptionId: string) =>
        Effect.flatMap(source, (found) =>
          found?.id === subscriptionId
            ? Effect.succeed(found)
            : Effect.fail(new Failed({ error: { kind: "no-subscription" } })),
        ),

      key: Effect.map(load, (subscription) => (subscription ? keyOf(subscription.stored) : null)),
    };
  });
}

function summary({ id, stored, provider }: Connected): SubscriptionSummary {
  return {
    kind: stored.kind,
    id,
    server: stored.server,
    username: stored.kind === "xtream" ? stored.username : "",
    account: stored.account,
    needsSecret: provider === null,
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

/**
 * The registry's entries as the file holds them, with where the original's entry is among them,
 * -1 without one. A registry that is missing or can't be read has none.
 */
async function readRegistry(path: string): Promise<{
  readonly entries: readonly object[];
  readonly at: number;
  readonly original: OriginalEntry | null;
}> {
  const entries = (await readJsonFile(path, Registry))?.subscriptions ?? [];
  for (const [at, entry] of entries.entries()) {
    const original = OriginalEntry(entry);
    if (!(original instanceof type.errors)) return { entries, at, original };
  }
  return { entries, at: -1, original: null };
}
