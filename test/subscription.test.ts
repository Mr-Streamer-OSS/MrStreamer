import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppFailure, type AppError } from "../src/shared/errors.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { mockProvider, tempDir, testSecrets, userAgent } from "./support.ts";

async function subscriptions() {
  const dataDir = await tempDir();
  const create = () =>
    createSubscriptions({ dataDir, secrets: testSecrets, providerOptions: { userAgent } });
  return { dataDir, create, service: create() };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof AppFailure))
    throw new Error(`Expected an AppFailure, got ${String(error)}`);
  return error.error;
}

describe("subscriptions", () => {
  it("connects with a valid login and reports the account", async () => {
    const provider = await mockProvider();
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
    const provider = await mockProvider();
    const { service } = await subscriptions();

    const summary = await service.connect({
      server: `${provider.url}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      username: "",
      password: "",
    });

    expect(summary).toMatchObject({ server: provider.url, username: "demo" });
  });

  it("rejects a wrong password", async () => {
    const provider = await mockProvider();
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: provider.url, username: "demo", password: "wrong" }),
    );

    expect(error).toEqual({ kind: "invalid-login" });
    expect(await service.get()).toBeNull();
  });

  it("explains an expired account", async () => {
    const provider = await mockProvider({ accountStatus: "Expired" });
    const { service } = await subscriptions();

    const error = await failure(
      service.connect({ server: provider.url, username: "demo", password: "demo" }),
    );

    expect(error).toMatchObject({ kind: "account-inactive", state: "expired" });
  });

  it("reports a server that cannot be reached", async () => {
    const provider = await mockProvider();
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
    const provider = await mockProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    await service.connect({
      server: `${provider.url}/`,
      username: "demo",
      password: "s3cret-pass",
    });

    const restarted = create();

    expect(await restarted.get()).toMatchObject({ server: provider.url, username: "demo" });
    expect(await restarted.recheck()).toMatchObject({ account: { state: "active" } });
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).not.toContain("s3cret-pass");
  });

  it("forgets the subscription when removed", async () => {
    const provider = await mockProvider();
    const { create, service } = await subscriptions();
    await service.connect({ server: provider.url, username: "demo", password: "demo" });

    await service.remove();

    expect(await service.get()).toBeNull();
    expect(await create().get()).toBeNull();
  });
});
