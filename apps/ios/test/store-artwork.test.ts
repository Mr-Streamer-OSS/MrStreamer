import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import sharp from "../../desktop/node_modules/sharp/dist/index.mjs";
import spec from "../assets/store/spec.json";

const exec = promisify(execFile);
const temporary: string[] = [];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function inputs() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/store-artwork-test-"));
  temporary.push(dir);
  const slots: Record<string, object> = {};

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

async function run(dir: string, slots: Record<string, object>, locale = "en-GB") {
  await writeFile(join(dir, "inputs.json"), JSON.stringify({ slots }));

  return exec(process.execPath, [
    "apps/ios/scripts/store-artwork.ts",
    "--input",
    join(dir, "inputs.json"),
    "--output",
    join(dir, locale),
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
      });
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
  await expect(readFile(join(dir, "en-GB", "manifest.json"))).rejects.toThrow();
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
  const manifest = JSON.parse(await readFile(join(dir, "en-GB/manifest.json"), "utf8"));
  const entry = manifest.exports[0];
  expect(entry.frame).toMatchObject({ sha256: hash(frame), nativeWidth: 2832, nativeHeight: 2144 });
  const { geometry, screenGeometry } = entry;

  const pixel = await sharp(join(dir, "en-GB/ipad-13.png"))
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
