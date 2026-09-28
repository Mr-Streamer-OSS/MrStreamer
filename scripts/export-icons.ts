// Renders the app icons from assets/brand/icon.svg.
// build/icon.png: 1024 px macOS icon (the squircle sits on Apple's grid with its margin and shadow).
// build/icon.icns: the same artwork at every size macOS asks for. Shipping it means electron-builder
//   never runs its own PNG to ICNS converter.
// build/icon.ico: Windows icon, cropped to the squircle so it fills the tile like other Windows apps.
// Usage: pnpm icons:export
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = await readFile(`${root}assets/brand/icon.svg`, "utf8");
await mkdir(`${root}build`, { recursive: true });

await sharp(Buffer.from(svg), { density: 72 })
  .resize(1024, 1024)
  .png()
  .toFile(`${root}build/icon.png`);

// ICNS element types that hold PNG data, with their pixel sizes.
const icnsTypes: [type: string, size: number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const macImages = await Promise.all(
  icnsTypes.map(async ([type, size]): Promise<[string, Buffer]> => [
    type,
    await sharp(Buffer.from(svg), { density: 72 * (size / 1024) * 4 })
      .resize(size, size)
      .png()
      .toBuffer(),
  ]),
);
await writeFile(`${root}build/icon.icns`, icns(macImages));

// Crop the 1024 canvas to the 824 px squircle body (plus a hair of margin) for Windows.
const windowsSvg = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="92 92 840 840"');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) =>
    sharp(Buffer.from(windowsSvg), { density: 72 * (size / 840) * 4 })
      .resize(size, size)
      .png()
      .toBuffer(),
  ),
);
await writeFile(`${root}build/icon.ico`, ico(sizes, pngs));
console.log("Wrote build/icon.png, build/icon.icns and build/icon.ico");

/** An ICNS file: a big-endian "icns" header followed by one PNG per element type. */
function icns(elements: [type: string, png: Buffer][]): Buffer {
  const chunks = elements.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

/** An ICO file that embeds PNG images, which every Windows version since Vista reads. */
function ico(sizes: number[], images: Buffer[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const size = sizes[index] ?? 0;
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}
