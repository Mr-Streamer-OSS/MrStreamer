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
      const repeated = JSON.parse(await readFile(join(dir, "repeat/manifest.json"), "utf8"));
      expect(repeated.exports.map((entry: { sha256: string }) => entry.sha256)).toEqual(
        manifest.exports.map((entry: { sha256: string }) => entry.sha256),
      );
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
  await expect(run(dir, slots)).rejects.toThrow(/provenance/);
  await expect(stat(join(dir, "en-US"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("places a local frame at its cutout without losing the captured screen", async () => {
  const { dir, slots } = await inputs();

  const frame = await sharp({
    create: { width: 2752, height: 2064, channels: 4, background: "#00000000" },
  })
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: "#abcdef" })
    .png()
    .toBuffer();

  await writeFile(join(dir, "frame.png"), frame);
  await writeFile(join(dir, "terms.txt"), "Synthetic test frame only, not Apple artwork.");
  slots["ipad-13"] = {
    ...slots["ipad-13"],
    frame: {
      file: "frame.png",
      source: "https://developer.apple.com/design/resources/",
      termsSource: "https://developer.apple.com/app-store/marketing/guidelines/",
      licenceFile: "terms.txt",
      cutout: { left: 40, top: 40, width: 2752, height: 2064 },
    },
  };
  await run(dir, slots);
  const manifest = JSON.parse(await readFile(join(dir, "en-US/manifest.json"), "utf8"));
  const entry = manifest.exports[0];
  expect(entry.frame).toEqual({
    source: "https://developer.apple.com/design/resources/",
    termsSource: "https://developer.apple.com/app-store/marketing/guidelines/",
    cutout: { left: 40, top: 40, width: 2752, height: 2064 },
    sha256: hash(frame),
    licenceSha256: hash(await readFile(join(dir, "terms.txt"))),
    nativeWidth: 2832,
    nativeHeight: 2144,
  });
  const { geometry, screenGeometry } = entry;

  const pixel = await sharp(join(dir, "en-US/ipad-13.png"))
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

async function withFrame(dir: string, slots: Record<string, Capture>, background = "#00000000") {
  const bytes = await sharp({ create: { width: 2832, height: 2144, channels: 4, background } })
    .png()
    .toBuffer();

  await writeFile(join(dir, "frame.png"), bytes);
  await writeFile(join(dir, "terms.txt"), "Synthetic frame licence record.");
  slots["ipad-13"]!.frame = {
    file: "frame.png",
    source: "https://developer.apple.com/design/resources/",
    termsSource: "https://developer.apple.com/app-store/marketing/guidelines/",
    licenceFile: "terms.txt",
    cutout: { left: 40, top: 40, width: 2752, height: 2064 },
  };
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

test("normalizes an absolute capture path to a path relative to the input", async () => {
  const { dir, slots } = await inputs();
  slots["ipad-13"]!.file = join(dir, "ipad-13.png");
  await run(dir, slots);
  const manifest = JSON.parse(await readFile(join(dir, "en-US/manifest.json"), "utf8"));
  expect(manifest.exports[0].capture.file).toBe("ipad-13.png");
  expect(manifest.exports[0].capture).not.toHaveProperty("frame");
});

test.each(["opaque", "obstructed"])("rejects a frame with an %s opening", async (kind) => {
  const { dir, slots } = await inputs();
  await withFrame(dir, slots, kind === "opaque" ? "#abcdef" : "#00000000");

  if (kind === "obstructed") {
    const bytes = await sharp(join(dir, "frame.png"))
      .composite([
        {
          input: await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } })
            .png()
            .toBuffer(),
          left: 1400,
          top: 1000,
        },
      ])
      .png()
      .toBuffer();

    await writeFile(join(dir, "frame.png"), bytes);
  }

  await expect(run(dir, slots)).rejects.toThrow(/cutout must be transparent/);
});

test.each(["terms", "licence", "slot"])("rejects invalid %s input", async (kind) => {
  const { dir, slots } = await inputs();
  await withFrame(dir, slots);

  if (kind === "terms") slots["ipad-13"]!.frame!.termsSource = "not a URL";

  if (kind === "licence") await writeFile(join(dir, "terms.txt"), " ");

  if (kind === "slot") slots["iphone-medium"] = slots["ipad-13"]!;
  await expect(run(dir, slots)).rejects.toThrow(
    kind === "terms"
      ? /termsSource must be an https URL/
      : kind === "licence"
        ? /licence.*non-empty/
        : /medium iPhone slot is outside this generator/,
  );
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
