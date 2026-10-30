import { describe, expect, it, vi } from "vitest";
import { createGuide } from "../src/guide.ts";
import { createGuides, GUIDE_LIMIT } from "../src/guide-sources.ts";
import type { SecretStore } from "../src/secrets.ts";
import { guideFixture } from "./native-guide.ts";

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.0" } } }));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0 }));

const LINK = "https://guide.test/epg.xml.gz?token=private-guide-token";

/** A launch: the guides file and Keychain as the last one left them, and a native store. */
function launch(disk: { file: unknown; items: Map<string, string> }) {
  const { native, control } = guideFixture();
  const prepared: string[] = [];
  control.prepare = async () => ({ kind: "failed", error: "network" });
  native.prepare = async (_lease, _job, url) => {
    prepared.push(url);
    return control.prepare();
  };
  const cancel = native.cancel;
  native.cancel = async (job) => {
    control.calls.push(`cancel:${job}`);
    return cancel(job);
  };
  const owner = createGuide(
    () => native,
    Date.now,
    () => undefined,
  );
  const refused = new Set<string>();
  /** The guides of each file written, by id. */
  const written: (readonly string[])[] = [];
  const secrets: SecretStore = {
    read: async (id) => disk.items.get(id) ?? null,
    async write(id, secret) {
      if (refused.has("write")) throw new Error("refused");
      disk.items.set(id, secret);
    },
    async remove(id) {
      if (refused.has("remove")) throw new Error("refused");
      control.calls.push(`keychain-remove:${id}`);
      disk.items.delete(id);
    },
    clear: async () => disk.items.clear(),
  };
  const guides = createGuides(
    secrets,
    owner,
    () => disk.file,
    (value) => {
      if (refused.has("file")) throw new Error("The disk is full.");
      disk.file = JSON.parse(JSON.stringify(value));
      written.push(value.guides.map(({ id }) => id));
    },
  );
  return { guides, owner, control, prepared, refused, disk, written };
}
const fresh = () => ({ file: null as unknown, items: new Map<string, string>() });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("external guides", () => {
  it("keeps the link in the Keychain alone and downloads the guide from it", async () => {
    const { guides, prepared, disk } = launch(fresh());
    guides.load();
    expect(await guides.add(`  ${LINK} `, "Weekly")).toBeNull();
    await flush();
    const [link] = guides.links();
    expect(link).toMatchObject({ origin: "https://guide.test", name: "Weekly", locked: false });
    expect(disk.items.get(link!.id)).toBe(LINK);
    expect(JSON.stringify(disk.file)).not.toContain("private-guide-token");
    expect(prepared).toEqual([LINK]);
  });

  it("refuses what isn't a new http(s) link, past the limit, or that the Keychain refuses", async () => {
    const { guides, refused, disk } = launch(fresh());
    guides.load();
    expect(await guides.add("ftp://guide.test/epg.xml")).toBe("address");
    expect(await guides.add("not a link")).toBe("address");
    expect(await guides.add(LINK)).toBeNull();
    expect(await guides.add(LINK)).toBe("duplicate");
    expect(await guides.add("https://named.test/epg.xml", LINK)).toBe("name");
    refused.add("write");
    expect(await guides.add("https://other.test/epg.xml")).toBe("saving");
    expect(guides.links()).toHaveLength(1);
    refused.clear();
    for (let i = guides.links().length; i < GUIDE_LIMIT; i++)
      expect(await guides.add(`https://guide.test/${i}.xml`)).toBeNull();
    expect(await guides.add("https://guide.test/last.xml")).toBe("limit");
    // The refused write's id was left pending; the next launch removes nothing saved.
    const next = launch(disk);
    next.guides.load();
    await next.guides.restore();
    expect(next.guides.links().filter((each) => !each.locked)).toHaveLength(GUIDE_LIMIT);
  });

  it("revokes a removed guide's native work before erasing it, then its link", async () => {
    const { guides, control, disk, refused } = launch(fresh());
    guides.load();
    await guides.add(LINK);
    await flush();
    const { id } = guides.links()[0]!;
    refused.add("file");
    expect(await guides.remove(id)).toBe("saving");
    expect(guides.links()).toHaveLength(1);
    expect(control.calls).not.toContain(`revoke:${id}`);
    refused.clear();
    expect(await guides.remove(id)).toBeNull();
    const order = control.calls.filter((call) => call.endsWith(`:${id}`));
    expect(order.slice(-3)).toEqual([`revoke:${id}`, `forget:${id}`, `keychain-remove:${id}`]);
    expect(guides.links()).toEqual([]);
    expect(disk.items.size).toBe(0);
  });

  it("removes at the next launch a link the Keychain kept", async () => {
    const disk = fresh();
    const { guides, refused } = launch(disk);
    guides.load();
    await guides.add(LINK);
    const { id } = guides.links()[0]!;
    refused.add("remove");
    expect(await guides.remove(id)).toBeNull();
    expect(disk.items.has(id)).toBe(true);
    const next = launch(disk);
    next.guides.load();
    await next.guides.restore();
    expect(disk.items.has(id)).toBe(false);
    expect(next.guides.links()).toEqual([]);
  });

  it("replaces a guide's link with a new guide in its place, erasing the old one", async () => {
    const { guides, control, prepared, written } = launch(fresh());
    guides.load();
    await guides.add("https://first.test/a.xml", "First");
    await guides.add(LINK, "Second");
    const first = guides.links()[0]!;
    const before = written.length;
    expect(await guides.replace(first.id, "https://new.test/a.xml")).toBeNull();
    // No file written meanwhile lists both the old guide and the new one.
    expect(written.slice(before).every((ids) => ids.length <= 2)).toBe(true);
    await flush();
    expect(guides.links().map(({ origin, name }) => [origin, name])).toEqual([
      ["https://new.test", "First"],
      ["https://guide.test", "Second"],
    ]);
    expect(control.calls).toContain(`forget:${first.id}`);
    expect(prepared.at(-1)).toBe("https://new.test/a.xml");
  });

  it("restores saved guides at launch, readable but locked where the Keychain lost a link", async () => {
    const disk = fresh();
    const before = launch(disk);
    before.guides.load();
    await before.guides.add(LINK);
    await before.guides.add("https://other.test/epg.xml");
    const lost = before.guides.links()[0]!;
    disk.items.delete(lost.id);
    const after = launch(disk);
    const ids = after.guides.load();
    expect(ids).toHaveLength(2);
    await after.owner.restore(ids);
    await after.guides.restore();
    await flush();
    expect(after.guides.links().map((each) => each.locked)).toEqual([true, false]);
    expect(after.prepared).toEqual(["https://other.test/epg.xml"]);
    // Its own link again unlocks it, under its id, so its saved guide stays.
    expect(await after.guides.replace(lost.id, LINK)).toBeNull();
    await flush();
    expect(after.guides.links().map((each) => [each.id, each.locked])).toEqual([
      [lost.id, false],
      [before.guides.links()[1]!.id, false],
    ]);
    expect(after.control.calls).not.toContain(`forget:${lost.id}`);
    expect(after.prepared.at(-1)).toBe(LINK);
  });

  it("shows no guides from a file another build wrote or it can't read, writing over neither", async () => {
    const { guides } = launch({ file: { version: 2 }, items: new Map() });
    expect(guides.load()).toEqual([]);
    expect(guides.links()).toEqual([]);
    expect(await guides.add(LINK)).toBe("saving");
    const locked = { file: null as unknown, items: new Map<string, string>() };
    const before = launch(locked);
    before.guides.load();
    await before.guides.add(LINK);
    const saved = locked.file;
    const after = createGuides(
      {
        read: async () => null,
        write: async () => {},
        remove: async () => {},
        clear: async () => {},
      },
      createGuide(
        () => guideFixture().native,
        Date.now,
        () => undefined,
      ),
      () => {
        throw new Error("Protected until the first unlock.");
      },
      (value) => {
        locked.file = value;
      },
    );
    expect(after.load()).toEqual([]);
    expect(await after.add("https://other.test/epg.xml")).toBe("saving");
    expect(await after.map("a:1", "news")).toBe("saving");
    await expect(after.erase("a")).rejects.toThrow();
    expect(locked.file).toBe(saved);
  });

  it("cancels a removed guide's download under way before erasing it", async () => {
    const { guides, owner, control } = launch(fresh());
    guides.load();
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => (started = resolve));
    control.prepare = () => {
      started();
      return new Promise(() => {});
    };
    await guides.add(LINK);
    await downloading;
    const { id } = guides.links()[0]!;
    expect(owner.status(id).activity).toBe("loading");
    await guides.remove(id);
    const revoked = control.calls.indexOf(`revoke:${id}`);
    const cancelled = control.calls.findIndex(
      (call, at) => at > revoked && call.startsWith("cancel:"),
    );
    expect(revoked).toBeGreaterThan(-1);
    expect(cancelled).toBeGreaterThan(revoked);
    expect(control.calls.indexOf(`forget:${id}`)).toBeGreaterThan(cancelled);
    expect(owner.status(id).availability).toBe("unknown");
  });
});

describe("channel mappings", () => {
  it("maps a channel by its key, clears it, and erases a subscription's with its history", async () => {
    const disk = fresh();
    const { guides } = launch(disk);
    guides.load();
    expect(await guides.map("a:1", " bbc-one.uk ")).toBeNull();
    expect(await guides.map("a:2", "news")).toBeNull();
    expect(await guides.map("b:1", "sport")).toBeNull();
    expect(await guides.map("a:2", "")).toBeNull();
    expect(await guides.map("a:3", "x".repeat(513))).toBe("long");
    expect(guides.mappings()).toEqual(
      new Map([
        ["a:1", "bbc-one.uk"],
        ["b:1", "sport"],
      ]),
    );
    await guides.erase("a");
    const next = launch(disk);
    next.guides.load();
    expect(next.guides.mappings()).toEqual(new Map([["b:1", "sport"]]));
  });
});
