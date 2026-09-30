// Renders the DMG window background, build/dmg-background.png and its @2x twin, with Chromium so
// the text uses the same system font as the Finder window around it. Run on a Mac after changing
// the artwork: `pnpm dmg:background`. electron-builder.yml places the app icon at x 190 and
// Applications at x 470, both at y 210, which this artwork frames.
//
// The DMG window takes its size from the image, title bar included, so the title bar hides the
// bottom of the image: the design fills the top 420 points and 32 spare points below stay black.
//
// Finder draws the icon labels itself, black in light mode and white in dark mode, about 85 points
// below each icon's centre. Only a mid-grey surface reads with both, so each label sits on a plate.
import { readFileSync, writeFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";

const WIDTH = 660;
/** 420 points of design, plus room for the title bar. */
const HEIGHT = 420 + 32;
const ICONS_X = [190, 470];
const LABEL_Y = 295;
const scale = Number(process.argv.at(-1)) === 2 ? 2 : 1;

const mark = readFileSync(new URL("../assets/brand/mark.svg", import.meta.url), "utf8");
const plates = ICONS_X.map(
  (x) => `<div style="position:absolute;left:${x - 50}px;top:${LABEL_Y - 11}px;width:100px;
    height:22px;border-radius:6px;background:#77777c"></div>`,
).join("");
const html = `<!doctype html>
<html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;color:#fff;
  font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(ellipse 60% 70% at 50% 55%,hsl(215 55% 14%),transparent 70%),#000">
  <div style="position:absolute;left:32px;top:28px;display:flex;align-items:center;gap:7px;
    font-size:14px;font-weight:700;letter-spacing:-0.02em">
    <span style="width:18px;height:18px;display:block">${mark.replace("<svg", '<svg width="18" height="18"')}</span>
    mr. streamer
  </div>
  <svg style="position:absolute;left:286px;top:198px" width="88" height="24" viewBox="0 0 88 24"
    fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.85">
    <path d="M3 12h72" stroke-dasharray="0.5 7"/>
    <path d="M73 4l10 8-10 8"/>
  </svg>
  ${plates}
  <div style="position:absolute;left:0;right:0;top:352px;text-align:center;font-size:14px;opacity:0.85">
    Drag Mr. Streamer to Applications
  </div>
</body></html>`;

// Electron emits "ready" only after the entry module has run, so this cannot await it at the top.
void app.whenReady().then(async () => {
  // Offscreen, so it renders without a display; the 2x image is the same page zoomed on a canvas
  // twice the size.
  const window = new BrowserWindow({
    show: false,
    width: WIDTH * scale,
    height: HEIGHT * scale,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: "#000000",
    webPreferences: { offscreen: true, zoomFactor: scale },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await window.webContents.capturePage();
  const name = scale === 2 ? "dmg-background@2x.png" : "dmg-background.png";
  writeFileSync(new URL(`../build/${name}`, import.meta.url), image.toPNG());
  console.log(`build/${name}: ${image.getSize().width} x ${image.getSize().height}`);
  app.quit();
});
