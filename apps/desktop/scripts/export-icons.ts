// Renders the app icons from assets/brand/icon.svg.
// build/icon.png: 1024 px macOS icon (the squircle sits on Apple's grid with its margin and shadow).
// build/icon.icns: the same artwork at every size macOS asks for. Shipping it means electron-builder
//   never runs its own PNG to ICNS converter.
// build/icon.ico: Windows icon, cropped to the squircle so it fills the tile like other Windows apps.
// build/appx: the Microsoft Store package's logos, from the same crop. electron-builder's appx target
//   packs every file there and indexes the scaled ones.
// Usage: pnpm icons:export
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// The Store package's logos at 100, 200 and 400 % scale. The app list and taskbar icon also comes
// at the pixel sizes Windows asks for, unplated, so Windows 11 draws it without a coloured square.
// Tiles centre the icon on transparency, over the manifest's black background.
await rm(`${root}build/appx`, { recursive: true, force: true });
await mkdir(`${root}build/appx`);
type Logo = { name: string; width: number; height: number; icon: number };
const square = (name: string, size: number, icon = size): Logo => ({
  name,
  width: size,
  height: size,
  icon,
});
const logos: Logo[] = [
  ...[16, 24, 32, 48, 256].flatMap((size) => [
    square(`Square44x44Logo.targetsize-${size}`, size),
    square(`Square44x44Logo.targetsize-${size}_altform-unplated`, size),
  ]),
  ...[1, 2, 4].flatMap((times) => [
    square(`StoreLogo.scale-${times * 100}`, 50 * times),
    square(`Square44x44Logo.scale-${times * 100}`, 44 * times),
    square(`Square150x150Logo.scale-${times * 100}`, 150 * times, 75 * times),
    {
      name: `Wide310x150Logo.scale-${times * 100}`,
      width: 310 * times,
      height: 150 * times,
      icon: 75 * times,
    },
  ]),
];
await Promise.all(
  logos.map(async ({ name, width, height, icon }) => {
    const art = await sharp(Buffer.from(windowsSvg), { density: 72 * (icon / 840) * 4 })
      .resize(icon, icon)
      .png()
      .toBuffer();
    const left = Math.floor((width - icon) / 2);
    const top = Math.floor((height - icon) / 2);
    await sharp(art)
      .extend({
        left,
        right: width - icon - left,
        top,
        bottom: height - icon - top,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(`${root}build/appx/${name}.png`);
  }),
);
console.log("Wrote build/icon.png, build/icon.icns, build/icon.ico and build/appx");

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
