import { keychain } from "./keychain.ts";
import { nativePlayer } from "./native-player.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Custom lists as the account erases a subscription's history with them: the production account,
// downloads and lists (account.ts, custom-lists.ts) over the real files stand-in
// (native-files.ts), with one of the desktop tests' fake Xtream panels for a personal provider.
// A refused write of the lists keeps that erasure pending, so nothing comes back afterwards.

const memory = vi.hoisted(() => ({ keychain: new Map<string, string>() }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("react-native", () => ({
  Alert: { alert: () => undefined },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo-secure-store", () => keychain(() => memory.keychain));
vi.mock("expo-video", () => ({ createVideoPlayer: () => nativePlayer(() => undefined) }));

const { native } = await import("./native-files.ts");
const { background } = await import("./native-downloads.ts");

interface FakeProvider {
  readonly url: string;
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
  }): Promise<FakeProvider>;
};
let panel: FakeProvider;
beforeAll(async () => {
  panel = await startFakeProvider({
    username: "one",
    password: "one+Pw@1",
    channels: 4,
    titles: 1,
  });
});
afterAll(() => panel.close());

const documents = join(native.root, "documents");
const lists = () => readFileSync(join(documents, "custom-lists.json"), "utf8");
const registry = () =>
  JSON.parse(readFileSync(join(documents, "subscriptions.json"), "utf8")) as { erasing: string[] };
/** Writes of the lists fail while this holds. */
let refused = false;

async function until(ready: () => boolean) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error("Timed out");
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  background.die();
  vi.resetModules();
  const account = await import("../src/account.ts");
  const channelLists = await import("../src/custom-lists.ts");
  const downloads = await import("../src/downloads.ts");
  await account.restore();
  downloads.startDownloads();
  return { ...channelLists, ...account };
}

beforeEach(async () => {
  await background.forceQuit();
  background.reset();
  for (const name of readdirSync(native.root))
    rmSync(join(native.root, name), { recursive: true, force: true });
  mkdirSync(documents);
  mkdirSync(join(native.root, "cache"));
  memory.keychain.clear();
  refused = false;
  native.sync = (operation, path) => {
    if (refused && operation === "write" && path.includes("custom-lists.json")) {
      throw new Error("The disk is full.");
    }
  };
});

describe("a list's channels, as their subscription's history is erased", () => {
  it("of a removed provider stay pending while the lists refuse the write, and go at the next launch", async () => {
    const app = await launch();
    const id = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
    if (!id) throw new Error("The add was cancelled");
    await until(() => app.currentCatalogue().kind === "ready");
    const catalogue = app.currentCatalogue();
    const first = catalogue.kind === "ready" ? catalogue.library.channels[0] : undefined;
    if (!first) throw new Error("No channel listed");
    app.createList("News", first);

    refused = true;
    await expect(app.remove(id, { keepHistory: false })).rejects.toThrow("The disk is full.");
    expect(registry().erasing).toEqual([id]);
    expect(lists()).toContain(id);

    refused = false;
    await launch();
    expect(registry().erasing).toEqual([]);
    expect(lists()).not.toContain(id);
  });

  it("of the Demo keep its erasure pending while the lists refuse the write, so a new Demo starts without them", async () => {
    expect(await (await launch()).startDemo()).toEqual({ kind: "started" });
    // The Demo lists no channels; one a list kept from it is named by its last name.
    writeFileSync(
      join(documents, "custom-lists.json"),
      JSON.stringify({
        version: 1,
        lists: [
          {
            id: "news",
            name: "News",
            revision: 0,
            members: [{ member: "m", subscriptionId: "demo", streams: ["10"], name: "Demo One" }],
          },
        ],
      }),
    );
    const app = await launch();
    await until(() => app.currentChannelLists()[0]?.entries.length === 1);

    refused = true;
    expect(await app.resetDemo()).toEqual({ kind: "incomplete", pending: ["history"] });
    expect(lists()).toContain("Demo One");

    refused = false;
    expect(await app.resetDemo()).toEqual({ kind: "started" });
    expect(app.currentChannelLists()[0]!.entries).toEqual([]);
    expect(lists()).not.toContain("Demo One");
  });
});
