import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import sharp from "../../desktop/node_modules/sharp/dist/index.mjs";
import spec from "../assets/store/spec.json";

type Capture = {
  file: string;
  sha256: string;
  provenance?: Record<string, string>;
  frame?: Record<string, unknown>;
};

const exec = promisify(execFile);
const temporary: string[] = [];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function inputs() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/store-artwork-test-"));
  temporary.push(dir);
  const slots: Record<string, Capture> = {};

  for (const slot of spec.slots) {
    const file = `${slot.id}.png`;

    const bytes = await sharp({
      create: { width: slot.width, height: slot.height, channels: 3, background: "#125678" },
    })
      .png()
      .toBuffer();

    await writeFile(join(dir, file), bytes);
    slots[slot.id] = {
      file,
      sha256: hash(bytes),
      provenance: {
        appCommit: "a".repeat(40),
        device: slot.id,
        os: "iOS 27.1",
        provider: "apps/ios/scripts/marketing-fixture.ts",
        capturedAt: "2026-11-03T09:41:00Z",
      },
    };
  }

  return { dir, slots };
}

async function run(dir: string, slots: Record<string, Capture>, locale = "en-US", output = locale) {
  await writeFile(join(dir, "inputs.json"), JSON.stringify({ slots }));

  return exec(process.execPath, [
    "apps/ios/scripts/store-artwork.ts",
    "--input",
    join(dir, "inputs.json"),
    "--output",
    join(dir, output),
    "--locale",
    locale,
  ]);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("exports opaque native-slot PNGs with bound inputs and geometry in every app language", async () => {
  const { dir, slots } = await inputs();
  const headlinePixels = new Map<string, Buffer[]>();

  for (const locale of Object.keys(spec.slots[0]!.headlines)) {
    await run(dir, slots, locale);
    const manifest = JSON.parse(await readFile(join(dir, locale, "manifest.json"), "utf8"));
    expect(manifest.exports).toHaveLength(3);
    expect(manifest.sources).toMatchObject({
      generatorSha256: hash(await readFile("apps/ios/scripts/store-artwork.ts")),
      node: process.version,
    });

    for (const slot of spec.slots) {
      const bytes = await readFile(join(dir, locale, `${slot.id}.png`));
      expect(await sharp(bytes).metadata()).toMatchObject({
        width: slot.width,
        height: slot.height,
        channels: 3,
        hasAlpha: false,
        format: "png",
      });
      expect(
        manifest.exports.find((entry: { slot: string }) => entry.slot === slot.id),
      ).toMatchObject({
        sha256: hash(bytes),
        capture: slots[slot.id],
        frame: "frameless",
        layout: slot,
        headline: (slot.headlines as Record<string, string>)[locale],
      });
      const column = slot.frameless;
      const top = column.top * slot.scale;
      const headlineHeight = slot.title.lines * slot.title.lineHeight * slot.scale;

      const ink = await sharp(bytes)
        .extract({ left: 0, top, width: slot.width, height: headlineHeight })
        .raw()
        .toBuffer();

      expect(ink.includes(255)).toBe(true);
      const previous = headlinePixels.get(slot.id) ?? [];

      for (const other of previous) expect(ink.equals(other)).toBe(false);
      headlinePixels.set(slot.id, [...previous, ink]);

      // Descenders can extend below the CSS line box; the lower half of the gap stays black.
      const gapHeight = Math.floor((column.gap * slot.scale) / 2);

      const gap = await sharp(bytes)
        .extract({
          left: 0,
          top: top + headlineHeight + column.gap * slot.scale - gapHeight,
          width: slot.width,
          height: gapHeight,
        })
        .raw()
        .toBuffer();

      expect(
        gap.every((channel) => channel === 0),
        `${slot.id} ${locale}`,
      ).toBe(true);
    }

    if (locale === "en-US") {
      await run(dir, slots, locale, "repeat");

      for (const file of ["manifest.json", ...spec.slots.map((slot) => `${slot.id}.png`)]) {
        expect(await readFile(join(dir, "repeat", file))).toEqual(
          await readFile(join(dir, locale, file)),
        );
      }
    }
  }
}, 60000);

test("refuses a layout reference instead of a native-pixel capture", async () => {
  const { dir, slots } = await inputs();

  const bytes = await sharp({
    create: { width: 1376, height: 1032, channels: 3, background: "black" },
  })
    .png()
    .toBuffer();

  await writeFile(join(dir, "ipad-13.png"), bytes);
  slots["ipad-13"] = { ...slots["ipad-13"], sha256: hash(bytes) };
  await expect(run(dir, slots)).rejects.toThrow(/native capture must be 2752x2064/);
});

test("refuses missing provenance before creating an output directory", async () => {
  const { dir, slots } = await inputs();
  slots["duo-inner"] = { file: "duo-inner.png", sha256: "a".repeat(64) };
  await expect(run(dir, slots)).rejects.toThrow(/duo-inner provenance must be an object/);
  await expect(stat(join(dir, "en-US"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("places a local frame at its cutout without losing the captured screen", async () => {
  const { dir, slots } = await inputs();

  const slot = spec.slots[1]!;
  const frame = await withFrame(dir, slots, slot.id);
  slots[slot.id]!.file = join(dir, `${slot.id}.png`);
  await run(dir, slots);
  const manifest = JSON.parse(await readFile(join(dir, "en-US/manifest.json"), "utf8"));
  const entry = manifest.exports[1];
  expect(entry.capture).toEqual({
    file: `${slot.id}.png`,
    sha256: slots[slot.id]!.sha256,
    provenance: slots[slot.id]!.provenance,
  });
  expect(entry.frame).toEqual({
    source: "https://developer.apple.com/design/resources/",
    termsSource: "https://developer.apple.com/app-store/marketing/guidelines/",
    cutout: { left: 40, top: 40, width: slot.width, height: slot.height },
    cornerRadius: RADIUS,
    opaqueShare: expect.any(Number),
    sha256: hash(frame),
    licenceSha256: hash(await readFile(join(dir, "terms.txt"))),
    nativeWidth: slot.width + 80,
    nativeHeight: slot.height + 80,
  });
  expect(entry.frame.opaqueShare).toBeGreaterThan(0);
  expect(entry.frame.opaqueShare).toBeLessThanOrEqual(0.01);
  const { geometry, screenGeometry } = entry;

  const pixel = await sharp(join(dir, `en-US/${slot.id}.png`))
    .extract({
      left: geometry.left + screenGeometry.left + Math.floor(screenGeometry.width / 2),
      top: geometry.top + screenGeometry.top + Math.floor(screenGeometry.height / 2),
      width: 1,
      height: 1,
    })
    .raw()
    .toBuffer();

  expect([...pixel]).toEqual([0x12, 0x56, 0x78]);
});

// Large enough that the rounded corners alone exceed the 1% opaque allowance, so a frame check
// that ignored cornerRadius and inspected a square opening would refuse these frames.
const RADIUS = 300;

async function withFrame(
  dir: string,
  slots: Record<string, Capture>,
  slotId = "ipad-13",
  openingOpacity = 0,
) {
  const slot = spec.slots.find((candidate) => candidate.id === slotId)!;
  const width = slot.width + 80;
  const height = slot.height + 80;

  // Synthetic geometry only: a rounded, anti-aliased opening and a small opaque island.
  const bytes = await sharp(
    Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <mask id="opening">
        <rect width="${width}" height="${height}" fill="white"/>
        <rect x="40" y="40" width="${slot.width}" height="${slot.height}" rx="${RADIUS}" fill="black"/>
      </mask>
      <rect width="${width}" height="${height}" fill="#abcdef" mask="url(#opening)"/>
      <rect x="40" y="40" width="${slot.width}" height="${slot.height}" rx="${RADIUS}" fill="white" opacity="${openingOpacity}"/>
      <rect x="${width / 2 - 75}" y="60" width="150" height="40" rx="20" fill="#abcdef"/>
    </svg>`),
  )
    .png()
    .toBuffer();

  await writeFile(join(dir, "frame.png"), bytes);
  await writeFile(join(dir, "terms.txt"), "Synthetic frame licence record.");
  slots[slotId]!.frame = {
    file: "frame.png",
    source: "https://developer.apple.com/design/resources/",
    termsSource: "https://developer.apple.com/app-store/marketing/guidelines/",
    licenceFile: "terms.txt",
    cutout: { left: 40, top: 40, width: slot.width, height: slot.height },
    cornerRadius: RADIUS,
  };

  return bytes;
}

test.each(["capture", "provenance", "frame", "cutout"])(
  "rejects unknown %s fields",
  async (target) => {
    const { dir, slots } = await inputs();
    await withFrame(dir, slots);
    const capture = slots["ipad-13"]!;

    const record =
      target === "capture"
        ? capture
        : target === "provenance"
          ? capture.provenance!
          : target === "frame"
            ? capture.frame!
            : (capture.frame!.cutout as Record<string, unknown>);

    Object.assign(record, { note: "https://private.invalid/stream?login=secret" });
    await expect(run(dir, slots)).rejects.toThrow(/unknown key.*note/);
    await expect(stat(join(dir, "en-US"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("rejects a mostly opaque frame opening and names its opaque share", async () => {
  const { dir, slots } = await inputs();
  await withFrame(dir, slots, "ipad-13", 0.9);
  await expect(run(dir, slots)).rejects.toThrow(/opaque share 100.00%.*at most 1%/);
  await expect(stat(join(dir, "en-US"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  {
    mutate: async (_dir: string, slots: Record<string, Capture>) => {
      slots["ipad-13"]!.frame!.termsSource = "http://developer.apple.com/terms/";
    },
    error: /termsSource must be an https Apple URL/,
  },
  {
    mutate: async (dir: string) => {
      await writeFile(join(dir, "terms.txt"), " ");
    },
    error: /licence.*non-empty/,
  },
  {
    mutate: async (_dir: string, slots: Record<string, Capture>) => {
      slots["iphone-medium"] = slots["ipad-13"]!;
    },
    error: /valid slots: ipad-13, duo-inner, duo-outer;.*medium iPhone/,
  },
  {
    mutate: async (_dir: string, slots: Record<string, Capture>) => {
      slots["ipad-13"]!.provenance!.device = "login:secret";
    },
    error: /device must be a plain label/,
  },
  {
    mutate: async (_dir: string, slots: Record<string, Capture>) => {
      slots["ipad-13"]!.frame!.termsSource = "https://login:secret@developer.apple.com/terms/";
    },
    error: /termsSource must be an https Apple URL/,
  },
])("rejects invalid input: $error", async ({ mutate, error }) => {
  const { dir, slots } = await inputs();
  await withFrame(dir, slots);
  await mutate(dir, slots);
  await expect(run(dir, slots)).rejects.toThrow(error);
});

test("rejects unknown top-level input fields", async () => {
  const { dir, slots } = await inputs();
  const file = join(dir, "inputs.json");
  await writeFile(file, JSON.stringify({ slots, note: "private operator notes" }));
  await expect(
    exec(process.execPath, [
      "apps/ios/scripts/store-artwork.ts",
      "--input",
      file,
      "--output",
      join(dir, "unknown"),
    ]),
  ).rejects.toThrow(/input: unknown key note/);
  await expect(stat(join(dir, "unknown"))).rejects.toMatchObject({ code: "ENOENT" });
});

// A genuine two-frame APNG: the default IDAT frame and a second identical fdAT frame.
function animated(png: Buffer) {
  const chunks: { type: string; data: Buffer }[] = [];

  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    chunks.push({
      type: png.toString("ascii", offset + 4, offset + 8),
      data: png.subarray(offset + 8, offset + 8 + size),
    });
    offset += size + 12;
  }

  const chunk = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const content = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(content));

    return Buffer.concat([size, content, checksum]);
  };

  const header = chunks[0]!.data;
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2);

  const frame = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence);
    header.copy(data, 4, 0, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);

    return chunk("fcTL", data);
  };

  const pixels = Buffer.concat(
    chunks
      .values()
      .filter((item) => item.type === "IDAT")
      .map((item) => item.data)
      .toArray(),
  );

  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);

  return Buffer.concat([
    png.subarray(0, 8),
    chunk("IHDR", header),
    chunk("acTL", control),
    frame(0),
    chunk("IDAT", pixels),
    frame(1),
    chunk("fdAT", Buffer.concat([sequence, pixels])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test.each(["capture", "frame"])("rejects an animated PNG %s", async (kind) => {
  const { dir, slots } = await inputs();
  await withFrame(dir, slots);
  const file = join(dir, kind === "frame" ? "frame.png" : "ipad-13.png");
  const bytes = animated(await readFile(file));
  await writeFile(file, bytes);

  if (kind === "capture") slots["ipad-13"]!.sha256 = hash(bytes);
  await expect(run(dir, slots)).rejects.toThrow(/animated PNG/);
});

// Isolated checkout skeleton exercises startup without changing this worktree's inputs.
async function checkout() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/store-artwork-checkout-"));
  temporary.push(dir);
  await mkdir(join(dir, "apps/ios/scripts"), { recursive: true });
  await mkdir(join(dir, "apps/ios/assets/store"), { recursive: true });
  await mkdir(join(dir, "apps/desktop"), { recursive: true });
  await cp("apps/ios/scripts/store-artwork.ts", join(dir, "apps/ios/scripts/store-artwork.ts"));
  await cp("apps/ios/assets/store/spec.json", join(dir, "apps/ios/assets/store/spec.json"));
  await symlink(
    resolve("apps/desktop/node_modules"),
    join(dir, "apps/desktop/node_modules"),
    "dir",
  );

  return dir;
}

test("shows usage before requiring .local and explains missing input storage", async () => {
  const dir = await checkout();
  const script = join(dir, "apps/ios/scripts/store-artwork.ts");
  await expect(exec(process.execPath, [script])).rejects.toThrow(/Usage:/);
  await expect(
    exec(process.execPath, [script, "--input", "inputs.json", "--output", "out"]),
  ).rejects.toThrow(/mkdir -p .local/);
});

test("requires the requested locale in every slot", async () => {
  const dir = await checkout();
  const incomplete = structuredClone(spec);
  Reflect.deleteProperty(incomplete.slots[1]!.headlines, "en-US");
  await writeFile(join(dir, "apps/ios/assets/store/spec.json"), JSON.stringify(incomplete));
  await expect(
    exec(process.execPath, [
      join(dir, "apps/ios/scripts/store-artwork.ts"),
      "--input",
      "inputs.json",
      "--output",
      "out",
    ]),
  ).rejects.toThrow(/Unsupported locale: en-US/);
});
