import { keychain } from "./keychain.ts";
import { guideFixture } from "./native-guide.ts";
import { nativePlayer } from "./native-player.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// External guides and mappings across launches: the production account and guide sources over the
// real files stand-in and one native guide store, with one of the desktop tests' fake Xtream
// panels. A refused write keeps a mapping erasure pending, and the next launch finishes it; a
// launch that can't read guides.json keeps the guides it names for the next.

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
const guidesPath = join(documents, "guides.json");
const guidesFile = () => readFileSync(guidesPath, "utf8");
/** The native guide store, kept across launches as its directory on disk is. */
let store = guideFixture();
/** Writes of guides.json fail while this holds. */
let refused = false;

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  background.die();
  vi.resetModules();
  const account = await import("../src/account.ts");
  const { guides } = await import("../src/guide-sources.ts");
  const { guide } = await import("../src/guide.ts");
  await account.restore();
  return { ...account, guides, guide };
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
  store = guideFixture();
  store.control.prepare = async () => ({ kind: "ok", value: { kind: "candidate", id: "c" } });
  vi.stubGlobal("expo", { modules: { Guide: store.native } });
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

async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

it.each([
  [
    "can't read",
    () =>
      (native.sync = (operation, path) => {
        if (operation === "text" && path === guidesPath)
          throw new Error("Locked until first unlock.");
      }),
  ],
  ["another build wrote", () => writeFileSync(guidesPath, JSON.stringify({ version: 2 }))],
])("keeps external guides through a launch whose guides.json it %s", async (_, hide) => {
  const app = await launch();
  const provider = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
  if (!provider) throw new Error("The add was cancelled");
  for (const link of ["kept", "removed", "replaced"])
    expect(await app.guides.add(`https://${link}.test/epg.xml`, link)).toBeNull();
  const [kept, removed, replaced] = app.guides.links().map(({ id }) => id);
  await until(
    () =>
      [provider, kept!, removed!, replaced!].every(
        (id) => app.guide.status(id).availability === "available",
      ),
    "every guide published",
  );
  const generation = (id: string) => store.control.activations.get(id)?.generation?.id;
  const saved = generation(kept!);
  // Their native erase fails, so only the next launch's cleanup takes them.
  store.control.forget = async () => false;
  expect(await app.guides.remove(removed!)).toBeNull();
  expect(await app.guides.replace(replaced!, "https://new.test/epg.xml")).toBeNull();
  const replacement = app.guides.links()[1]!.id;
  store.control.forget = async () => true;
  const file = guidesFile();

  hide();
  const blind = await launch();
  expect(blind.guides.links()).toEqual([]);
  expect(blind.guide.status(provider).availability).toBe("available");
  expect(blind.guide.status(kept!).availability).toBe("unknown");

  native.sync = null;
  writeFileSync(guidesPath, file);
  const next = await launch();
  expect(next.guides.links().map(({ id }) => id)).toEqual([kept, replacement]);
  expect(next.guide.status(kept!).availability).toBe("available");
  expect(generation(kept!)).toBe(saved);
  // Removed and replaced guides' leftovers are erased, never shown again.
  expect(generation(removed!)).toBeUndefined();
  expect(generation(replaced!)).toBeUndefined();
  // Their links stayed in the Keychain too.
  await until(() => next.guides.links().every(({ locked }) => !locked), "the links read");
});

it("erases every external guide's saved programmes at a launch without guides.json", async () => {
  const app = await launch();
  expect(await app.guides.add("https://kept.test/epg.xml")).toBeNull();
  const { id } = app.guides.links()[0]!;
  await until(() => app.guide.status(id).availability === "available", "the guide published");
  rmSync(guidesPath);
  const next = await launch();
  expect(next.guides.links()).toEqual([]);
  expect(store.control.activations.has(id)).toBe(false);
});
