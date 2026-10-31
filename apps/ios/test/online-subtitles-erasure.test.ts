import { keychain } from "./keychain.ts";
import { nativePlayer } from "./native-player.ts";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Downloaded subtitles as the account erases a subscription's history: the production account
// (account.ts) over the real files stand-in, with one of the desktop tests' fake Xtream panels.
// What a version keeps goes with its provider's history, and with the Demo's at its reset.

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
    channels: 1,
    titles: 1,
  });
});
afterAll(() => panel.close());

const documents = join(native.root, "documents");
const kept = () => {
  const folder = join(documents, "online-subtitles");
  return existsSync(folder) ? readdirSync(folder) : [];
};

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  background.die();
  vi.resetModules();
  const account = await import("../src/account.ts");
  const subtitles = await import("../src/downloaded-subtitles.ts");
  const downloads = await import("../src/downloads.ts");
  await account.restore();
  downloads.startDownloads();
  return { ...account, ...subtitles };
}

/** Keeps a downloaded subtitle for a movie of `subscriptionId`, as choosing a result does. */
function keepFor(app: Awaited<ReturnType<typeof launch>>, subscriptionId: string) {
  const title = app.subtitleTitle({
    subscriptionId,
    id: "7",
    tmdbId: "550",
    title: "Movie",
    year: 2001,
  });
  app.playSubtitles(title);
  const shown = app.showDownloaded(title, {
    service: "subdl",
    language: "en",
    release: "Movie.2001",
    cues: [{ start: 1, end: 2, text: "Hello" }],
  });
  app.playSubtitles(null);
  if (!shown) throw new Error("Not kept");
}

beforeEach(async () => {
  await background.forceQuit();
  background.reset();
  for (const name of readdirSync(native.root))
    rmSync(join(native.root, name), { recursive: true, force: true });
  mkdirSync(documents);
  mkdirSync(join(native.root, "cache"));
  memory.keychain.clear();
  native.sync = null;
});

describe("downloaded subtitles, as their subscription's history is erased", () => {
  it.each([
    [true, 1],
    [false, 0],
  ])("of a provider removed keeping its history %s: %i left", async (keepHistory, left) => {
    const app = await launch();
    const id = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
    if (!id) throw new Error("The add was cancelled");
    keepFor(app, id);
    expect(kept()).toHaveLength(1);
    await app.remove(id, { keepHistory });
    expect(kept()).toHaveLength(left);
  });

  it("of the Demo go at its reset", async () => {
    const app = await launch();
    expect(await app.startDemo()).toEqual({ kind: "started" });
    keepFor(app, "demo");
    expect(kept()).toHaveLength(1);
    expect(await app.resetDemo()).toEqual({ kind: "started" });
    expect(kept()).toHaveLength(0);
  });
});
