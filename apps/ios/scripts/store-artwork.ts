// Compose candidates only. Native captures and inspected Apple frames stay in .local/.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp, {
  type Metadata,
  type OverlayOptions,
} from "../../desktop/node_modules/sharp/dist/index.mjs";
import spec from "../assets/store/spec.json" with { type: "json" };

const root = fileURLToPath(new URL("../../..", import.meta.url));
const fontPath = resolve(root, "apps/desktop/assets/brand/fonts/Inter.ttf");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    locale: { type: "string", default: "en-US" },
  },
});

if (!values.input || !values.output) {
  throw new Error(
    "Usage: node apps/ios/scripts/store-artwork.ts --input .local/inputs.json --output .local/store-candidates [--locale en-US]",
  );
}

const locale = values.locale;

if (!spec.slots.every((slot) => Object.hasOwn(slot.headlines, locale)))
  throw new Error(`Unsupported locale: ${locale}`);

let local: string;

try {
  local = await realpath(resolve(root, ".local"));
} catch (cause) {
  throw new Error(
    "Create this worktree's .local/ directory and put capture inputs there before running the generator (mkdir -p .local).",
    { cause },
  );
}

/** Reject unrecognised metadata rather than copying operator notes into exports. */
function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${label}: unknown key ${key}`);
}

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

knownKeys(config, ["slots"], "input");

const slots = object(config.slots, "slots");

for (const id of Object.keys(slots)) {
  if (!spec.slots.some((slot) => slot.id === id))
    throw new Error(`Unknown slot: ${id}; the medium iPhone slot is outside this generator`);
}

const output = insideLocal(resolve(values.output));

// Resolve the parent to prevent a symlink from redirecting writes out of this worktree.
const outputParent = await realpath(dirname(output));

if (outputParent !== local) insideLocal(outputParent);

const font = await readFile(fontPath);
const exports = [];
const { title: titleStyle, hairline } = spec.style;

// Pango crops rendered text to its ink. An invisible bar at each end of a line gives every
// line the same box whatever its glyphs, so lines sit on a fixed baseline across languages.
const strut = '<span alpha="1">|</span>';

// Where that box starts against a CSS line box, in ems: its top is INK_TOP above the line's
// middle and its left is INK_LEFT before the text origin. Measured on Paper's own exports of
// these headlines, within 1 point at every slot size.
const INK_TOP = 0.607;
const INK_LEFT = 0.253;

// A headline longer than the design's reserves shrinks, down to this share of its Paper size.
const MIN_TITLE_SCALE = 0.8;

type Slot = (typeof spec.slots)[number];

type Box = { width: number; height: number };

const markup = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Renders one headline line at a pixel size; `advance` is its CSS width with letter spacing. */
async function renderLine(text: string, px: number) {
  const render = (content: string) =>
    sharp({
      text: {
        text: `<span foreground="${titleStyle.colour}" weight="${titleStyle.weight}" letter_spacing="${Math.round(titleStyle.letterSpacing * px * 1024)}">${strut}${content}${strut}</span>`,
        font: `${titleStyle.font} ${px}`,
        fontfile: fontPath,
        dpi: 72,
        rgba: true,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });

  const [line, empty] = await Promise.all([render(markup(text)), render("")]);

  return { data: line.data, advance: line.info.width - empty.info.width };
}

/**
 * Wraps a headline greedily into the column like the Paper text box, shrinking it a point at a
 * time until it fits the slot's reserved lines. Sizes are in points; lines come back rendered.
 */
async function fitTitle(text: string, slot: Slot, width: number) {
  const words = text.split(" ");

  for (let size = slot.title.size; size >= slot.title.size * MIN_TITLE_SCALE; size--) {
    const px = size * slot.scale;
    const lines: Awaited<ReturnType<typeof renderLine>>[] = [];
    let current = await renderLine(words[0]!, px);
    let currentText = words[0]!;

    for (const word of words.slice(1)) {
      const longer = await renderLine(`${currentText} ${word}`, px);

      if (longer.advance <= width * slot.scale) {
        current = longer;
        currentText = `${currentText} ${word}`;
      } else {
        lines.push(current);
        current = await renderLine(word, px);
        currentText = word;
      }
    }

    lines.push(current);

    if (
      lines.length <= slot.title.lines &&
      lines.every((line) => line.advance <= width * slot.scale)
    )
      return {
        size,
        px,
        lineHeight: (slot.title.lineHeight * size * slot.scale) / slot.title.size,
        lines,
      };
  }

  throw new Error(`${slot.id}: "${text}" does not fit ${slot.title.lines} line(s) of its column`);
}

/** A single-page PNG without an EXIF rotation, so its pixels are what composition sees. */
function uprightPng(info: Metadata, bytes: Buffer) {
  // Sharp can report no pages for APNG. Walk PNG chunks, not arbitrary compressed bytes.
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new Error("animated PNG inputs are not supported");
      offset += bytes.readUInt32BE(offset) + 12;
    }
  }

  return info.format === "png" && (info.pages || 1) === 1 && (info.orientation || 1) === 1;
}

/**
 * Paper A with a supplied frame: the frame scaled into the picture box, the capture resized
 * into its cutout underneath. The manifest records the frame with its file and licence hashes.
 */
async function framed(slot: Slot, capture: Buffer, value: unknown, box: Box) {
  const supplied = object(value, "frame");
  knownKeys(supplied, ["file", "source", "termsSource", "licenceFile", "cutout"], "frame");

  const frameSource = string(supplied.source, "frame.source");

  if (!frameSource.startsWith("https://developer.apple.com/"))
    throw new Error("frame.source must be an Apple Developer URL");
  const termsSource = string(supplied.termsSource, "frame.termsSource");

  if (!URL.canParse(termsSource) || new URL(termsSource).protocol !== "https:")
    throw new Error("frame.termsSource must be an https URL");

  const licence = await inputFile(
    resolve(dirname(input.file), string(supplied.licenceFile, "frame.licenceFile")),
  );

  if (!licence.bytes.toString("utf8").trim()) throw new Error("frame licence must be non-empty");

  const image = await inputFile(resolve(dirname(input.file), string(supplied.file, "frame.file")));
  const info = await sharp(image.bytes).metadata();

  if (!uprightPng(info, image.bytes) || !info.hasAlpha || !info.width || !info.height)
    throw new Error("frame must be an upright transparent PNG");
  const cutout = object(supplied.cutout, "frame.cutout");
  knownKeys(cutout, ["left", "top", "width", "height"], "frame.cutout");
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

  // Permit rounded corners within 5% of the opening's shorter side. Every other
  // opening pixel, including its centre and straight edges, must reveal the capture.
  const inset = Math.floor(Math.min(width, height) * 0.05);

  const alpha = await sharp(image.bytes)
    .extract({ left, top, width, height })
    .extractChannel("alpha")
    .raw()
    .toBuffer();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const corner = (x < inset || x >= width - inset) && (y < inset || y >= height - inset);

      if (!corner && alpha[y * width + x] !== 0)
        throw new Error("frame cutout must be transparent outside the rounded corner inset");
    }
  }

  const resized = await sharp(image.bytes)
    .resize({ ...box, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  const scale = resized.info.width / info.width;

  const screenGeometry = {
    left: Math.round(left * scale),
    top: Math.round(top * scale),
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };

  if (screenGeometry.width > slot.width || screenGeometry.height > slot.height)
    throw new Error("frame would upscale the capture");

  const screen = await sharp(capture)
    .resize(screenGeometry.width, screenGeometry.height, { fit: "fill" })
    .png()
    .toBuffer();

  const picture = await sharp({
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

  return {
    picture,
    width: resized.info.width,
    height: resized.info.height,
    screenGeometry,
    frame: {
      source: frameSource,
      termsSource,
      cutout: { left, top, width, height },
      sha256: hash(image.bytes),
      licenceSha256: hash(licence.bytes),
      nativeWidth: info.width,
      nativeHeight: info.height,
    },
  };
}

/** The frameless fallback: the capture inside a square-corner hairline, never simulated hardware. */
async function frameless(slot: Slot, capture: Buffer, box: Box) {
  const border = hairline.width * slot.scale;

  const screen = await sharp(capture)
    .resize({
      width: box.width - border * 2,
      height: box.height - border * 2,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const picture = await sharp(screen.data)
    .extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: hairline.colour,
    })
    .png()
    .toBuffer();

  return {
    picture,
    width: screen.info.width + border * 2,
    height: screen.info.height + border * 2,
    screenGeometry: {
      left: border,
      top: border,
      width: screen.info.width,
      height: screen.info.height,
    },
    frame: "frameless" as const,
  };
}

for (const slot of spec.slots) {
  const capture = object(slots[slot.id], `${slot.id} capture`);
  knownKeys(capture, ["file", "sha256", "provenance", "frame"], "capture");
  const provenance = object(capture.provenance, `${slot.id} provenance`);
  knownKeys(provenance, ["appCommit", "device", "os", "provider", "capturedAt"], "provenance");

  const appCommit = string(provenance.appCommit, "provenance.appCommit");

  if (!/^[a-f0-9]{40}$/.test(appCommit))
    throw new Error("provenance.appCommit must be a full Git SHA");
  const device = string(provenance.device, "provenance.device");
  const os = string(provenance.os, "provenance.os");
  const provider = string(provenance.provider, "provenance.provider");
  const capturedAt = string(provenance.capturedAt, "provenance.capturedAt");

  if (
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(capturedAt) ||
    !Number.isFinite(Date.parse(capturedAt))
  )
    throw new Error("provenance.capturedAt must be an ISO timestamp with timezone");

  if (provider !== "apps/ios/scripts/marketing-fixture.ts")
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
    !uprightPng(metadata, source.bytes)
  ) {
    throw new Error(
      `${slot.id}: native capture must be ${slot.width}x${slot.height}, single-page upright PNG`,
    );
  }

  if (metadata.hasAlpha && !(await sharp(source.bytes).stats()).isOpaque)
    throw new Error(`${slot.id}: capture must be opaque`);

  // Paper A for a supplied frame, the frameless fallback row otherwise: a headline column over
  // the picture, both centred, the picture at most the column's width and box height.
  const column = capture.frame === undefined ? slot.frameless : slot.framed;
  const box = { width: column.width * slot.scale, height: column.height * slot.scale };

  const { picture, width, height, screenGeometry, frame } =
    capture.frame === undefined
      ? await frameless(slot, source.bytes, box)
      : await framed(slot, source.bytes, capture.frame, box);

  const headlines: Record<string, string> = slot.headlines;
  const headline = headlines[locale]!;

  const title = await fitTitle(headline, slot, column.width);
  const columnLeft = (slot.width - column.width * slot.scale) / 2;
  const columnTop = column.top * slot.scale;

  // The picture follows the reserved headline lines and the Paper gap, so it stays put in every language.
  const geometry = {
    left: Math.floor((slot.width - width) / 2),
    top: columnTop + (slot.title.lines * slot.title.lineHeight + column.gap) * slot.scale,
    width,
    height,
  };

  if (geometry.left < 0 || geometry.top + geometry.height > slot.height)
    throw new Error(`${slot.id}: picture does not fit the slot`);

  const layers: OverlayOptions[] = [
    { input: picture, left: geometry.left, top: geometry.top },
    ...title.lines.map((line, index) => ({
      input: line.data,
      left: Math.round(columnLeft - INK_LEFT * title.px),
      top: Math.round(
        columnTop + index * title.lineHeight + title.lineHeight / 2 - INK_TOP * title.px,
      ),
    })),
  ];

  const bytes = await sharp({
    create: {
      width: slot.width,
      height: slot.height,
      channels: 3,
      background: spec.style.background,
    },
  })
    .composite(layers)
    .flatten({ background: spec.style.background })
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
    capture: {
      file: relative(dirname(input.file), source.file),
      sha256: hash(source.bytes),
      provenance: {
        appCommit,
        device,
        os,
        provider,
        capturedAt,
      },
    },
    frame,
    layout: slot,
    geometry,
    screenGeometry,
    headline,
    headlineSize: title.size,
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
        generatorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
        node: process.version,
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
