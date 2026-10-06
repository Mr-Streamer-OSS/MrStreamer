// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LATEST,
  installers,
  showDownloads,
  writeDownloads,
  type Downloads,
} from "../src/downloads.ts";
import type { System } from "../src/system.ts";

// The home page as a visitor gets it: index.html under styles.css, with <html> marked as the
// script in the head marks it. What shows is what the stylesheet leaves on display.

const root = join(import.meta.dirname, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

const STORE = "https://apps.microsoft.com/detail/9N45GG76ZP4T?referrer=appbadge";
const FILES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download";
const RELEASED: Downloads = { version: "0.0.7", installers };

/**
 * Opens the page for a visitor on `system`, undefined for one whose system the script couldn't
 * name. The build wrote `downloads` into it, or nothing when it found no release.
 */
function open(system?: System, downloads?: Downloads): void {
  const page = downloads ? writeDownloads(html, downloads) : html;
  document.documentElement.innerHTML = page.replace(
    /<link rel="stylesheet"[^>]*>/,
    `<style>${css}</style>`,
  );
  if (system) document.documentElement.dataset["os"] = system;
  else document.documentElement.removeAttribute("data-os");
}

const displayed = (node: Node): boolean =>
  !(node instanceof HTMLElement) || getComputedStyle(node).display !== "none";

/** The elements matching `selector` that show. */
const shown = (selector: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(selector)].filter(displayed);

/** What an element says, without the parts of it that don't show. */
const said = (element: Element): string =>
  [...element.childNodes]
    .filter(displayed)
    .map((node) => node.textContent)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** The hero's buttons and the lines under them, as [words, address] and words. */
const hero = () => ({
  buttons: shown(".hero .actions a").map((button) => [
    said(button) || button.querySelector("img")?.alt,
    button.getAttribute("href"),
  ]),
  lines: shown(".hero .note").map(said),
});

/** The links in Downloads, as [words, address]. */
const listed = () =>
  shown("#downloads dl a").map((link) => [said(link), link.getAttribute("href")]);

describe("the hero", () => {
  it("offers Downloads, which scrolls to the list, when the system is unknown", () => {
    open(undefined, RELEASED);

    expect(hero()).toEqual({
      buttons: [["Downloads", "#downloads"]],
      lines: ["macOS 13 or later on Apple silicon, Windows 11, 64-bit Linux."],
    });
  });

  it("offers the Microsoft Store alone on Windows", () => {
    open("windows", RELEASED);

    expect(hero()).toEqual({
      buttons: [["Get it from Microsoft", STORE]],
      lines: ["Windows 11, 64-bit. The Store keeps it updated. Setup .exe and other systems."],
    });
  });

  it("offers the DMG alone on a Mac", () => {
    open("mac", RELEASED);

    expect(hero()).toEqual({
      buttons: [["Download for Mac", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-mac-arm64.dmg`]],
      lines: ["Version 0.0.7. macOS 13 or later, Apple silicon only. Other systems."],
    });
  });

  it("offers the AppImage alone on Linux", () => {
    open("linux", RELEASED);

    expect(hero()).toEqual({
      buttons: [["Download for Linux", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-x86_64.AppImage`]],
      lines: ["Version 0.0.7. 64-bit Linux. The AppImage needs FUSE 2. .deb and other systems."],
    });
  });

  it("names no version, and sends its button to the Releases page, without a known installer", () => {
    open("mac");
    expect(hero()).toEqual({
      buttons: [["Download for Mac", LATEST]],
      lines: ["macOS 13 or later, Apple silicon only. Other systems."],
    });

    // The release is out, without its AppImage.
    open("linux", { version: "0.0.8", installers: ["dmg", "exe", "deb"] });
    expect(hero()).toEqual({
      buttons: [["Download for Linux", LATEST]],
      lines: ["64-bit Linux. The AppImage needs FUSE 2. .deb and other systems."],
    });
  });
});

describe("Downloads", () => {
  it.each([undefined, "windows", "mac", "linux"] as const)(
    "lists the Store and every installer for a visitor on %s",
    (system) => {
      open(system, RELEASED);

      expect(listed()).toEqual([
        ["Download the DMG", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-mac-arm64.dmg`],
        ["Microsoft Store", STORE],
        ["Download the setup .exe", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-win-x64-setup.exe`],
        ["Download the AppImage", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-x86_64.AppImage`],
        ["Download the .deb", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-amd64.deb`],
      ]);
    },
  );

  it("sends every installer to the Releases page, and says so, when no release is known", () => {
    open();

    expect(listed()).toEqual([
      ["Download the DMG on GitHub Releases", LATEST],
      ["Microsoft Store", STORE],
      ["Download the setup .exe on GitHub Releases", LATEST],
      ["Download the AppImage on GitHub Releases", LATEST],
      ["Download the .deb on GitHub Releases", LATEST],
    ]);
  });

  it("links the installers a release has, and the Releases page for the one it lacks", () => {
    open(undefined, { version: "0.0.8", installers: ["dmg", "exe", "appImage"] });

    expect(listed()).toEqual([
      ["Download the DMG", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-mac-arm64.dmg`],
      ["Microsoft Store", STORE],
      ["Download the setup .exe", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-win-x64-setup.exe`],
      ["Download the AppImage", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-linux-x86_64.AppImage`],
      ["Download the .deb on GitHub Releases", LATEST],
    ]);
  });
});

describe("a release published after the build", () => {
  const body = () => document.body.innerHTML;

  it.each<[string, Downloads]>([
    ["a newer one", { version: "0.0.8", installers }],
    ["one without its .deb and DMG", { version: "0.0.8", installers: ["exe", "appImage"] }],
    ["one with no installer", { version: "0.0.8", installers: [] }],
    ["the one before, after the newest was withdrawn", { version: "0.0.6", installers }],
  ])("leaves the open page as a build with it would: %s", (_, later) => {
    open("mac", later);
    const built = body();

    open("mac", RELEASED);
    showDownloads(document, later);

    expect(body()).toBe(built);
  });
});
