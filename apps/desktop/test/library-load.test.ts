import { join } from "node:path";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

// Hold a completed disk read at the storage boundary, so removal and caller cancellation can
// happen before that old answer is published. No catalogue internals are exposed to the tests.
const heldReads = vi.hoisted(
  () => new Map<string, { began(): void; readonly release: Promise<void> }>(),
);
vi.mock("../src/main/platform/json-file.ts", async (original) => {
  const actual = await original<typeof import("../src/main/platform/json-file.ts")>();
  const read: typeof actual.readJsonFile = async (path, schema) => {
    const value = await actual.readJsonFile(path, schema);
    const held = heldReads.get(path);
    if (held) {
      heldReads.delete(path);
      held.began();
      await held.release;
    }
    return value;
  };
  return { ...actual, readJsonFile: read };
});

async function setup() {
  const dir = await tempDir();
  const provider = await fakeProvider();
  const start = async () => {
    const runtime = runtimeFor(
      Library.layer().pipe(
        Layer.provideMerge(Settings.layer(dir)),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: dir,
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    return {
      runtime,
      library: await promised(runtime, Library),
      subscriptions: await promised(runtime, Subscriptions),
    };
  };
  const first = await start();
  const { id } = await first.subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await first.library.refresh(id);
  const channel = (await first.library.channels({}))[0]!;
  await first.runtime.dispose();
  const app = await start();
  const source = (await app.subscriptions.saved())[0]!;
  let began = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldReads.set(join(source.dir, "catalogue.json"), { began, release: released });
  return { ...app, source, channel, started, release };
}

describe("pending catalogue reads", () => {
  it("cannot revive a removed channel through the lookup waiting for the old disk answer", async () => {
    const app = await setup();
    const lookup = app.library.lookup(app.source.id).catch(() => null);
    await app.started;
    try {
      await app.library.forget(app.source);
      await app.subscriptions.remove(app.source.id);
    } finally {
      app.release();
    }
    expect((await lookup)?.(app.channel.id)).toBeUndefined();
  });

  it("lets one caller cancel while another still receives the shared offline catalogue", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const stop = new AbortController();
    const first = app.runtime
      .runPromise(library.lookup(app.source.id), { signal: stop.signal })
      .catch(() => null);
    await app.started;
    const second = app.library.channels({});
    stop.abort();
    app.release();
    await first;
    expect((await second).some((channel) => channel.id === app.channel.id)).toBe(true);
  });
});
