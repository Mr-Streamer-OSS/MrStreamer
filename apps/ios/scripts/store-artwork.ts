// Compose candidates only. Native captures and inspected Apple frames stay in .local/.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "../../desktop/node_modules/sharp/dist/index.mjs";
import spec from "../assets/store/spec.json" with { type: "json" };

const root = fileURLToPath(new URL("../../..", import.meta.url));
const local = await realpath(resolve(root, ".local"));
const fontPath = resolve(root, "apps/desktop/assets/brand/fonts/Inter.ttf");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    locale: { type: "string", default: "en-GB" },
  },
});

if (!values.input || !values.output) {
  throw new Error(
    "Usage: node apps/ios/scripts/store-artwork.ts --input .local/inputs.json --output .local/store-candidates [--locale en-GB]",
  );
}

const locale = values.locale;

if (!Object.hasOwn(spec.slots[0]!.headlines, locale))
  throw new Error(`Unsupported locale: ${locale}`);

/** JSON is untrusted: require objects and named values before using any capture metadata. */
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);

  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);

  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label} must be an integer >= ${minimum}`);

  return value;
}

function insideLocal(path: string): string {
  const rel = relative(local, path);

  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Inputs and outputs must be inside this worktree's .local/");

  return path;
}

async function inputFile(path: string) {
  const file = insideLocal(await realpath(path));

  return { file, bytes: await readFile(file) };
}

const input = await inputFile(resolve(values.input));
const config = object(JSON.parse(input.bytes.toString()), "input");
const slots = object(config.slots, "slots");
const output = insideLocal(resolve(values.output));

// Resolve the parent to prevent a symlink from redirecting writes out of this worktree.
const outputParent = await realpath(dirname(output));

if (outputParent !== local) insideLocal(outputParent);

const font = await readFile(fontPath);
const exports = [];

for (const slot of spec.slots) {
  const capture = object(slots[slot.id], `${slot.id} capture`);
  const provenance = object(capture.provenance, `${slot.id} provenance`);
  const appCommit = string(provenance.appCommit, "provenance.appCommit");

  if (!/^[a-f0-9]{40}$/.test(appCommit))
    throw new Error("provenance.appCommit must be a full Git SHA");
  string(provenance.device, "provenance.device");
  string(provenance.os, "provenance.os");
  const capturedAt = string(provenance.capturedAt, "provenance.capturedAt");

  if (
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(capturedAt) ||
    !Number.isFinite(Date.parse(capturedAt))
  )
    throw new Error("provenance.capturedAt must be an ISO timestamp with timezone");

  if (provenance.provider !== "apps/ios/scripts/marketing-fixture.ts")
    throw new Error("provenance.provider must name apps/ios/scripts/marketing-fixture.ts");

  const source = await inputFile(
    resolve(dirname(input.file), string(capture.file, "capture.file")),
  );

  if (string(capture.sha256, "capture.sha256") !== hash(source.bytes))
    throw new Error(`${slot.id}: capture SHA-256 mismatch`);
  const metadata = await sharp(source.bytes).metadata();

  if (
    metadata.width !== slot.width ||
    metadata.height !== slot.height ||
    metadata.format !== "png" ||
    (metadata.pages && metadata.pages > 1) ||
    (metadata.orientation && metadata.orientation !== 1)
  ) {
    throw new Error(
      `${slot.id}: native capture must be ${slot.width}x${slot.height}, single-page upright PNG`,
    );
  }

  if (metadata.hasAlpha && !(await sharp(source.bytes).stats()).isOpaque)
    throw new Error(`${slot.id}: capture must be opaque`);

  let frame: "frameless" | Record<string, unknown> = "frameless";
  let picture: Buffer;
  let screenGeometry;

  if (capture.frame !== undefined) {
    const supplied = object(capture.frame, "frame");
    const frameSource = string(supplied.source, "frame.source");

    if (!frameSource.startsWith("https://developer.apple.com/"))
      throw new Error("frame.source must be an Apple Developer URL");
    const termsSource = string(supplied.termsSource, "frame.termsSource");

    const licence = await inputFile(
      resolve(dirname(input.file), string(supplied.licenceFile, "frame.licenceFile")),
    );

    const image = await inputFile(
      resolve(dirname(input.file), string(supplied.file, "frame.file")),
    );

    const info = await sharp(image.bytes).metadata();

    if (
      info.format !== "png" ||
      !info.hasAlpha ||
      !info.width ||
      !info.height ||
      (info.pages && info.pages > 1) ||
      (info.orientation && info.orientation !== 1)
    )
      throw new Error("frame must be an upright transparent PNG");
    const cutout = object(supplied.cutout, "frame.cutout");
    const left = integer(cutout.left, "cutout.left");
    const top = integer(cutout.top, "cutout.top");
    const width = integer(cutout.width, "cutout.width", 1);
    const height = integer(cutout.height, "cutout.height", 1);

    if (
      left + width > info.width ||
      top + height > info.height ||
      Math.abs(width / height / (slot.width / slot.height) - 1) > 0.005
    )
      throw new Error(
        "frame cutout must fit the frame and match the capture aspect ratio without rotation",
      );

    const resized = await sharp(image.bytes)
      .resize({
        width: slot.picture.width,
        height: slot.picture.height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    const scale = resized.info.width / info.width;
    screenGeometry = {
      left: Math.round(left * scale),
      top: Math.round(top * scale),
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };

    if (screenGeometry.width > slot.width || screenGeometry.height > slot.height)
      throw new Error("frame would upscale the capture");

    const screen = await sharp(source.bytes)
      .resize(screenGeometry.width, screenGeometry.height, { fit: "fill" })
      .png()
      .toBuffer();

    picture = await sharp({
      create: {
        width: resized.info.width,
        height: resized.info.height,
        channels: 3,
        background: "#000",
      },
    })
      .composite([
        { input: screen, left: screenGeometry.left, top: screenGeometry.top },
        { input: resized.data, left: 0, top: 0 },
      ])
      .png()
      .toBuffer();
    frame = {
      ...supplied,
      source: frameSource,
      termsSource,
      sha256: hash(image.bytes),
      licenceSha256: hash(licence.bytes),
      nativeWidth: info.width,
      nativeHeight: info.height,
    };
  } else {
    const border = slot.scale; // One point at the slot's native scale, square corners.

    const screen = await sharp(source.bytes)
      .resize({
        width: slot.picture.width - border * 2,
        height: slot.picture.height - border * 2,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    picture = await sharp(screen.data)
      .extend({ top: border, bottom: border, left: border, right: border, background: "#2C2C2E" })
      .png()
      .toBuffer();
    screenGeometry = {
      left: border,
      top: border,
      width: screen.info.width,
      height: screen.info.height,
    };
  }

  const headlines: Record<string, string> = slot.headlines;
  const headline = headlines[locale]!;

  const title = await sharp({
    text: {
      text: `<span foreground="#fff" weight="700">${headline}</span>`,
      font: `Inter ${slot.title.size}`,
      fontfile: fontPath,
      dpi: 72,
      rgba: true,
      width: slot.title.width,
      wrap: "word",
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });

  if (title.info.height > slot.title.height)
    throw new Error(`${slot.id}: headline exceeds its reserved area`);
  const pictureInfo = await sharp(picture).metadata();

  const geometry = {
    left: slot.picture.left + Math.floor((slot.picture.width - pictureInfo.width!) / 2),
    top: slot.picture.top + Math.floor((slot.picture.height - pictureInfo.height!) / 2),
    width: pictureInfo.width!,
    height: pictureInfo.height!,
  };

  const layers: OverlayOptions[] = [
    { input: picture, left: geometry.left, top: geometry.top },
    { input: title.data, left: slot.title.left, top: slot.title.top },
  ];

  const bytes = await sharp({
    create: { width: slot.width, height: slot.height, channels: 3, background: "#000" },
  })
    .composite(layers)
    .flatten({ background: "#000" })
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer();

  exports.push({
    slot: slot.id,
    file: `${slot.id}.png`,
    width: slot.width,
    height: slot.height,
    format: "PNG",
    alpha: false,
    bytes: bytes.length,
    sha256: hash(bytes),
    capture,
    frame,
    layout: slot,
    geometry,
    screenGeometry,
    headline,
    data: bytes,
  });
}

// Validate and render the entire batch first; never overwrite an existing candidate set.
await mkdir(output);

for (const entry of exports) await writeFile(resolve(output, entry.file), entry.data);

await writeFile(
  resolve(output, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      acceptance:
        "Candidates only. Source qualification and final visual acceptance remain separate.",
      locale,
      spec,
      sources: {
        inputSha256: hash(input.bytes),
        font: {
          file: relative(root, fontPath),
          sha256: hash(font),
          licence: "SIL Open Font License 1.1; apps/desktop/assets/brand/fonts/Inter-LICENSE.txt",
        },
        sharp: sharp.versions,
      },
      exports: exports.map(({ data: _data, ...entry }) => entry),
    },
    null,
    2,
  )}\n`,
);
