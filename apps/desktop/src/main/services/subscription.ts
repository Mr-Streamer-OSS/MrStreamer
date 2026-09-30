// The one connected subscription: validated with the provider, stored with a sealed password.
import { join } from "node:path";
import { type } from "arktype";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountStatus, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import type { Secrets } from "../platform/secrets.ts";
import type { LiveProvider, ProviderOptions } from "@mrstreamer/core/provider";
import { parseLogin, xtreamProvider } from "../providers/xtream.ts";
import type { CatalogueSource } from "./library.ts";

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

interface Connected {
  readonly stored: StoredSubscription;
  /** Null when the saved password cannot be read any more; the user has to enter it again. */
  readonly provider: LiveProvider | null;
}

export interface SubscriptionDeps {
  readonly dataDir: string;
  readonly secrets: Secrets;
  readonly providerOptions: ProviderOptions;
}

export type Subscriptions = ReturnType<typeof createSubscriptions>;

export function createSubscriptions(deps: SubscriptionDeps) {
  const path = join(deps.dataDir, "subscription.json");
  let current: Promise<Connected | null> | null = null;
  /** Counts logins and removals, so a login that finishes late cannot undo a newer one. */
  let changes = 0;
  let writes: Promise<unknown> = Promise.resolve();

  /**
   * Runs storage changes one at a time. Provider requests happen before, so each task checks
   * that its change still applies and a slow answer never overwrites a newer state.
   */
  function write<T>(task: () => Promise<T>): Promise<T> {
    const run = writes.then(task);
    writes = run.catch(() => {});
    return run;
  }

  function load(): Promise<Connected | null> {
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
  }

  function connected(stored: StoredSubscription, password: string): Connected {
    const account = { server: stored.server, username: stored.username, password };
    return { stored, provider: xtreamProvider(account, deps.providerOptions) };
  }

  async function save(stored: StoredSubscription, password: string): Promise<SubscriptionSummary> {
    await writeJsonFile(path, stored);
    const next = connected(stored, password);
    current = Promise.resolve(next);
    return summary(next);
  }

  return {
    async get(): Promise<SubscriptionSummary | null> {
      const subscription = await load();
      return subscription ? summary(subscription) : null;
    },

    /** Checks the login with the provider, then stores it. Replaces any earlier subscription. */
    async connect(input: LoginInput): Promise<SubscriptionSummary> {
      const change = ++changes;
      const account = parseLogin(input);
      const status = await xtreamProvider(account, deps.providerOptions).authenticate();
      const stored: StoredSubscription = {
        version: 1,
        kind: "xtream",
        server: account.server,
        username: account.username,
        sealedPassword: deps.secrets.seal(account.password),
        account: status,
      };
      return write(async () => {
        if (change !== changes) {
          throw new AppFailure({
            kind: "unexpected",
            detail: "The subscription changed while this login was being checked.",
          });
        }
        return save(stored, account.password);
      });
    },

    /**
     * Asks the provider for the latest account status (expiry, connections) and stores it,
     * unless the subscription was removed or replaced while the provider answered.
     */
    async recheck(): Promise<SubscriptionSummary | null> {
      const subscription = await load();
      if (!subscription?.provider) return subscription ? summary(subscription) : null;
      const account: AccountStatus = await subscription.provider.authenticate();
      return write(async () => {
        const latest = await load();
        if (latest !== subscription) return latest ? summary(latest) : null;
        const password = deps.secrets.open(subscription.stored.sealedPassword);
        return save({ ...subscription.stored, account }, password);
      });
    },

    async remove(): Promise<void> {
      changes++;
      await write(async () => {
        current = Promise.resolve(null);
        await removeFile(path);
      });
    },

    /** The provider behind the subscription, keyed so the library can tell logins apart. */
    async source(): Promise<CatalogueSource | null> {
      const subscription = await load();
      if (!subscription?.provider) return null;
      const { server, username } = subscription.stored;
      return { key: `${server}|${username}`, provider: subscription.provider };
    },
  };
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
