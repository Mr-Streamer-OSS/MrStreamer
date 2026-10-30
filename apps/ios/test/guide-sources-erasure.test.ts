import { keychain } from "./keychain.ts";
import { nativePlayer } from "./native-player.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// Guide mappings as the account erases a subscription's history with them: the production account
// and guide sources over the real files stand-in, with one of the desktop tests' fake Xtream
// panels. A refused write keeps that erasure pending, and the next launch finishes it.

const memory = vi.hoisted(() => ({ keychain: new Map<string, string>() }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.0" } } }));
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
    channels: 2,
    titles: 1,
  });
});
afterAll(() => panel.close());

const documents = join(native.root, "documents");
const guidesFile = () => readFileSync(join(documents, "guides.json"), "utf8");
/** Writes of guides.json fail while this holds. */
let refused = false;

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  background.die();
  vi.resetModules();
  const account = await import("../src/account.ts");
  const { guides } = await import("../src/guide-sources.ts");
  await account.restore();
  return { ...account, guides };
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
    if (refused && operation === "write" && path.includes("guides.json"))
      throw new Error("The disk is full.");
  };
});

it("erases a removed provider's guide mappings with its history, finishing at the next launch", async () => {
  const app = await launch();
  const id = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
  if (!id) throw new Error("The add was cancelled");
  expect(await app.guides.map(`${id}:1`, "news.test")).toBeNull();
  expect(await app.guides.map("other:1", "kept.test")).toBeNull();

  refused = true;
  await expect(app.remove(id, { keepHistory: false })).rejects.toThrow("The disk is full.");
  expect(guidesFile()).toContain(id);

  refused = false;
  const next = await launch();
  expect([...next.guides.mappings()]).toEqual([["other:1", "kept.test"]]);
  expect(guidesFile()).not.toContain(id);
});
