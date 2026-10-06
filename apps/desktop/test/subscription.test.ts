import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** A JSON file of the data folder, or null when it isn't there. */
async function saved(dataDir: string, name: string): Promise<unknown> {
  const text = await readFile(join(dataDir, name), "utf8").catch(() => null);
  return text === null ? null : JSON.parse(text);
}

/**
 * What the stable release leaves when it connects `login` in `dataDir`: its subscription.json,
 * which this build writes the same way, and nothing else changed. It knows no registry.
 */
async function stableConnects(dataDir: string, login: Parameters<typeof connectAs>[1]) {
  const elsewhere = await subscriptions();
  await connectAs(elsewhere.service, login);
  await copyFile(join(elsewhere.dataDir, "subscription.json"), join(dataDir, "subscription.json"));
}

function connectAs(
  service: Awaited<ReturnType<typeof subscriptions>>["service"],
  login: { readonly server: string; readonly username: string; readonly password: string },
) {
  return service.connect(login);
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

  it("forgets the subscription when removed, with its sealed password and its id", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "s3cret-pass" };
    const { id } = await service.connect(login);
    const sealed = testSecrets.seal("s3cret-pass");

    await service.remove();

    expect(await service.get()).toBeNull();
    expect(await (await create()).get()).toBeNull();
    // Nothing of the login is left in the folder, in any file.
    const left = await Promise.all(
      (await readdir(dataDir)).map((name) => readFile(join(dataDir, name), "utf8")),
    );
    for (const text of left) {
      expect(text).not.toContain(sealed);
      expect(text).not.toContain("s3cret-pass");
      expect(text).not.toContain(id);
    }
    await expect(service.sourceOf(id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });
});

describe("a subscription's id", () => {
  it("names the subscription across restarts, and holds nothing of the login", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "s3cret-pass" };

    const { id } = await service.connect(login);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await (await create()).get())?.id).toBe(id);
    // The registry holds the id and the account it names: no password, sealed or not.
    const registry = await readFile(join(dataDir, "subscriptions.json"), "utf8");
    expect(JSON.parse(registry)).toEqual({
      version: 1,
      subscriptions: [{ id, original: true, key: `${provider.url}|demo` }],
    });
    expect(registry).not.toContain("s3cret-pass");
    expect(registry).not.toContain(testSecrets.seal("s3cret-pass"));
  });

  it("stays when the same login is entered again, and changes for another account", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider()];
    const { create, service } = await subscriptions();
    const login = { server: first.url, username: "demo", password: "demo" };
    const { id } = await service.connect(login);
    const before = await service.source();

    // The password entered again, as after the keychain lost it.
    expect((await service.connect(login)).id).toBe(id);
    const again = await service.source();
    // The provider's own answer about the account changes neither.
    await service.recheck();

    expect(again?.id).toBe(id);
    expect(again?.revision).toBeGreaterThan(before?.revision ?? Infinity);
    expect((await service.source())?.revision).toBe(again?.revision);

    const other = await service.connect({ ...login, server: second.url });

    expect(other.id).not.toBe(id);
    expect((await (await create()).get())?.id).toBe(other.id);
  });

  it("answers for the subscription a request names, and for no other", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();
    const { id } = await service.connect({
      server: provider.url,
      username: "demo",
      password: "demo",
    });

    expect(await service.sourceOf(id)).toMatchObject({ id, key: `${provider.url}|demo` });
    expect(await failure(service.sourceOf("another-subscription"))).toEqual({
      kind: "no-subscription",
    });
  });
});

describe("a profile other releases share", () => {
  const demo = (provider: { readonly url: string }) => ({
    server: provider.url,
    username: "demo",
    password: "demo",
  });

  it("keeps subscription.json as the stable release reads and writes it", async () => {
    const provider = await fakeProvider();
    const { dataDir, service } = await subscriptions();

    await service.connect(demo(provider));

    expect(await saved(dataDir, "subscription.json")).toEqual({
      version: 1,
      kind: "xtream",
      server: provider.url,
      username: "demo",
      sealedPassword: testSecrets.seal("demo"),
      account: expect.objectContaining({ state: "active" }),
    });
  });

  it("takes up a profile from before the registry without changing its login", async () => {
    const provider = await fakeProvider();
    const { dataDir, create } = await subscriptions();
    await stableConnects(dataDir, demo(provider));
    const before = await readFile(join(dataDir, "subscription.json"), "utf8");

    const upgraded = await create();
    const summary = await upgraded.get();

    expect(summary).toMatchObject({ server: provider.url, username: "demo", needsSecret: false });
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).toBe(before);
    // The login it holds is the one the provider is asked with.
    expect(await upgraded.recheck()).toMatchObject({ account: { state: "active" } });
    // The id it got then is the one it keeps.
    expect((await (await create()).get())?.id).toBe(summary?.id);
  });

  it("settles a write cut short between the login and the registry", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider()];
    const { dataDir, create, service } = await subscriptions();
    const { id } = await service.connect(demo(first));

    // Another account's login reached the disk, and the registry didn't follow.
    await stableConnects(dataDir, demo(second));
    const replaced = await (await create()).get();

    expect(replaced).toMatchObject({ server: second.url });
    expect(replaced?.id).not.toBe(id);
    expect((await (await create()).get())?.id).toBe(replaced?.id);

    // A removal took the login, and the registry didn't follow.
    await rm(join(dataDir, "subscription.json"));

    expect(await (await create()).get()).toBeNull();
    expect(await saved(dataDir, "subscriptions.json")).toEqual({ version: 1, subscriptions: [] });
  });

  it.each([
    ["isn't JSON", "{ not json"],
    ["holds something else", JSON.stringify({ version: 1, subscriptions: "none" })],
  ])("carries on with the login when the registry %s", async (_case, text) => {
    const provider = await fakeProvider();
    const { dataDir, create, service } = await subscriptions();
    await service.connect(demo(provider));
    await writeFile(join(dataDir, "subscriptions.json"), text);

    const restarted = await create();
    const summary = await restarted.get();

    expect(summary).toMatchObject({ server: provider.url, username: "demo", needsSecret: false });
    expect(await restarted.recheck()).toMatchObject({ account: { state: "active" } });
    // Written anew, and good from then on.
    expect(await saved(dataDir, "subscriptions.json")).toEqual({
      version: 1,
      subscriptions: [{ id: summary?.id, original: true, key: `${provider.url}|demo` }],
    });
    expect((await (await create()).get())?.id).toBe(summary?.id);
  });

  it("follows what the stable release did with the login, and leaves other entries alone", async () => {
    const [first, second] = [
      await fakeProvider({ password: "first-pass" }),
      await fakeProvider({ password: "other-pass" }),
    ];
    const login = { server: first.url, username: "demo", password: "first-pass" };
    const { dataDir, create, service } = await subscriptions();
    const { id } = await service.connect(login);
    // An entry as a later build keeps for a subscription added beside this one.
    const added = { id: "added-later", server: "https://tv.example", sealedPassword: "c2VhbGVk" };
    const registry = async () =>
      (await saved(dataDir, "subscriptions.json")) as { subscriptions: unknown[] };
    await writeFile(
      join(dataDir, "subscriptions.json"),
      JSON.stringify({ version: 1, subscriptions: [added, ...(await registry()).subscriptions] }),
    );

    // The saved password no longer the account's, and entered again there.
    const stale = { ...((await saved(dataDir, "subscription.json")) as object) };
    await writeFile(
      join(dataDir, "subscription.json"),
      JSON.stringify({ ...stale, sealedPassword: testSecrets.seal("stale-pass") }),
    );
    expect(await failure((await create()).recheck())).toEqual({ kind: "invalid-login" });
    await stableConnects(dataDir, login);
    const same = await create();

    expect((await same.get())?.id).toBe(id);
    expect(await same.recheck()).toMatchObject({ account: { state: "active" } });

    // Another account connected there.
    await stableConnects(dataDir, { ...login, server: second.url, password: "other-pass" });
    const other = await (await create()).get();

    expect(other).toMatchObject({ server: second.url });
    expect(other?.id).not.toBe(id);
    expect((await registry()).subscriptions).toEqual([
      added,
      { id: other?.id, original: true, key: `${second.url}|demo` },
    ]);

    // The subscription removed there.
    await rm(join(dataDir, "subscription.json"));

    expect(await (await create()).get()).toBeNull();
    expect((await registry()).subscriptions).toEqual([added]);

    // And one connected here again joins what the registry kept.
    const back = await (await create()).connect(login);

    expect((await registry()).subscriptions).toEqual([
      added,
      { id: back.id, original: true, key: `${first.url}|demo` },
    ]);
  });
});
