import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import type { Secrets } from "../src/main/platform/secrets.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

/** The subscription service on a data folder; `create` starts another, as after a restart. */
async function subscriptions(fetchImpl: typeof fetch = fetch) {
  const dataDir = await tempDir();
  const create = (secrets: Secrets = testSecrets) =>
    promised(
      runtimeFor(
        Subscriptions.layer({ dataDir, secrets, providerOptions: { userAgent, fetch: fetchImpl } }),
      ),
      Subscriptions,
    );
  return { dataDir, create, service: await create() };
}

/** A fetch that can hold the provider's answer to the next request until the test releases it. */
function holdableFetch() {
  let next: { arrived: () => void; answer: Promise<void> } | null = null;
  const holdable: typeof fetch = async (input, init) => {
    const held = next;
    next = null;
    held?.arrived();
    const response = await fetch(input, init);
    await held?.answer;
    return response;
  };
  return {
    fetch: holdable,
    holdNext() {
      const arrived = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      next = { arrived: arrived.resolve, answer: answer.promise };
      return { arrived: arrived.promise, release: answer.resolve };
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof Failed)) throw new Error(`Expected a failure, got ${String(error)}`);
  return error.error;
}

describe("subscriptions", () => {
  it("connects with a valid login and reports the account", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const summary = await service.connect({
      server: provider.url,
      username: "demo",
      password: "demo",
    });

    expect(summary).toMatchObject({ kind: "xtream", server: provider.url, username: "demo" });
    expect(summary.account.state).toBe("active");
    expect(summary.account.maxConnections).toBe(1);
    expect(Date.parse(summary.account.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("accepts a pasted M3U link that carries the login", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const summary = await service.connect({
      server: `${provider.url}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      username: "",
      password: "",
    });

    expect(summary).toMatchObject({ server: provider.url, username: "demo" });
  });

  it("rejects a wrong password", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: provider.url, username: "demo", password: "wrong" }),
    );

    expect(error).toEqual({ kind: "invalid-login" });
    expect(await service.get()).toBeNull();
  });

  it("explains an expired account", async () => {
    const provider = await fakeProvider({ accountStatus: "Expired" });
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: provider.url, username: "demo", password: "demo" }),
    );

    expect(error).toMatchObject({ kind: "account-inactive", state: "expired" });
  });

  it("reports a server that cannot be reached", async () => {
    const provider = await fakeProvider();
    await provider.close();
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: provider.url, username: "demo", password: "demo" }),
    );

    expect(error).toMatchObject({ kind: "unreachable", server: provider.url });
  });

  it("asks for the missing parts of a login", async () => {
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: "line.example.tv:8080", username: "demo", password: "" }),
    );

    expect(error.kind).toBe("incomplete-login");
  });

  it("survives a restart without storing the password in plain text", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    await service.connect({
      server: `${provider.url}/`,
      username: "demo",
      password: "s3cret-pass",
    });

    const restarted = await create();

    expect(await restarted.get()).toMatchObject({ server: provider.url, username: "demo" });
    expect(await restarted.recheck()).toMatchObject({ account: { state: "active" } });
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).not.toContain("s3cret-pass");
  });

  it("keeps a removal when an account check answers afterwards", async () => {
    const provider = await fakeProvider();
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    await service.connect({ server: provider.url, username: "demo", password: "demo" });

    const held = holdable.holdNext();
    const check = service.recheck();
    await held.arrived;
    await service.remove();
    held.release();

    expect(await check).toBeNull();
    expect(await service.get()).toBeNull();
    expect(await (await create()).get()).toBeNull();
  });

  it("keeps a newer login when an account check answers afterwards", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider()];
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    await service.connect({ server: first.url, username: "demo", password: "demo" });

    const held = holdable.holdNext();
    const check = service.recheck();
    await held.arrived;
    await service.connect({ server: second.url, username: "demo", password: "demo" });
    held.release();
    await check;

    expect(await service.get()).toMatchObject({ server: second.url });
    expect(await (await create()).get()).toMatchObject({ server: second.url });
  });

  it("asks for the password again when the keychain no longer opens it", async () => {
    const provider = await fakeProvider();
    const { create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "demo" };
    await service.connect(login);

    // What a new app signature or a reset keychain looks like to the app.
    const locked = await create({
      seal: testSecrets.seal,
      open: () => {
        throw new AppFailure({ kind: "keychain-refused" });
      },
    });

    expect(await locked.get()).toMatchObject({ username: "demo", needsSecret: true });
    expect(await locked.source()).toBeNull();
    expect(await locked.recheck()).toMatchObject({ needsSecret: true });
    expect(await locked.connect(login)).toMatchObject({ needsSecret: false });
  });

  it("forgets the subscription when removed", async () => {
    const provider = await fakeProvider();
    const { create, service } = await subscriptions();
    await service.connect({ server: provider.url, username: "demo", password: "demo" });

    await service.remove();

    expect(await service.get()).toBeNull();
    expect(await (await create()).get()).toBeNull();
  });
});
