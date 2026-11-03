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
async function fitTitle(text: string, slot: (typeof spec.slots)[number], width: number) {
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
  // Paper A for a supplied frame, the frameless fallback row otherwise: a headline column over
  // the picture, both centred, the picture at most the column's width and box height.
  const column = capture.frame === undefined ? slot.frameless : slot.framed;
  const box = { width: column.width * slot.scale, height: column.height * slot.scale };

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
        width: box.width,
        height: box.height,
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
    const border = hairline.width * slot.scale; // Square corners, so it never reads as hardware.

    const screen = await sharp(source.bytes)
      .resize({
        width: box.width - border * 2,
        height: box.height - border * 2,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    picture = await sharp(screen.data)
      .extend({
        top: border,
        bottom: border,
        left: border,
        right: border,
        background: hairline.colour,
      })
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

  const title = await fitTitle(headline, slot, column.width);
  const pictureInfo = await sharp(picture).metadata();
  const columnLeft = (slot.width - column.width * slot.scale) / 2;
  const columnTop = column.top * slot.scale;

  // The picture follows the reserved headline lines and the Paper gap, so it stays put in every language.
  const geometry = {
    left: Math.floor((slot.width - pictureInfo.width!) / 2),
    top: columnTop + (slot.title.lines * slot.title.lineHeight + column.gap) * slot.scale,
    width: pictureInfo.width!,
    height: pictureInfo.height!,
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
    capture,
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
