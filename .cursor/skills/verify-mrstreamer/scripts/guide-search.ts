// Public window proof for the full-horizon guide search. Only the provider boundary is fake.
import { translate } from "../../../../packages/core/src/i18n.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

const rows = "document.querySelectorAll('[data-guide-row]').length";
const field = "document.querySelector('section input')";

/** A multi-page guide with past, current and future airings and optional episode facts. */
export function searchGuide(): string {
  const stamp = (n: number) =>
    new Date(n).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

  const now = Math.floor(Date.now() / 3600000) * 3600000;
  const id = "aac.test";

  const programmes = Array.from({ length: 240 }, (_, i) => {
    const start = now + (i - 48) * 3600000;

    const metadata =
      i % 3 === 0
        ? '<episode-num system="xmltv_ns">1.3.</episode-num><sub-title>The Final Lap</sub-title><previously-shown/><premiere>Festival</premiere>'
        : i % 3 === 1
          ? '<episode-num system="xmltv_ns">broken</episode-num><new/>'
          : "";

    return `<programme channel="${id}" start="${stamp(start)}" stop="${stamp(start + 3600000)}"><title>Weekly ${i}</title><desc>Fixture programme ${i}</desc>${metadata}</programme>`;
  });

  return `<tv><channel id="${id}"><display-name>Fixture</display-name></channel>${programmes.join("")}</tv>`;
}

function expect(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

/** Header and palette entry, paging/reset, day filters, save/restart/remove and keyboard exit. */
export async function guideSearchScenario(d: Driver): Promise<void> {
  const button = (text: string) => named("section button", text);

  const search = async (text: string) => {
    await d.click("Focus guide search", field);

    for (const type of ["rawKeyDown", "keyUp"])
      await d.send("Input.dispatchKeyEvent", {
        type,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
    await d.send("Input.insertText", { text });
    await d.wait(async () => (await d.evaluate<number>(rows)) > 0);
  };

  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.click("Header calendar", "document.querySelector('[data-guide-search-opener]')");
  await d.wait(() => d.exists(`${field} === document.activeElement`));
  await search("Weekly");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.capture("guide-first-page");
  await d.click("Show more", button("Show more"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 100);
  d.observed.paging = { first: 50, next: 100 };
  await d.capture("guide-second-page");
  await d.click("Tomorrow", button("Tomorrow"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  await d.click("Save search", button("Save search"));
  await d.wait(() => d.exists(button("Weekly")));
  await d.capture("guide-saved-tomorrow");
  await d.click("Any day", button("Any day"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.click("Saved Weekly", button("Weekly"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  await d.quit();
  await d.launch();
  await d.click("Open Live TV after restart", named("header button", "Live TV"));
  await d.click(
    "Header calendar after restart",
    "document.querySelector('[data-guide-search-opener]')",
  );
  await d.wait(() => d.exists(button("Weekly")));
  await d.click("Apply saved search after restart", button("Weekly"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  d.observed.savedRestart = true;
  await d.capture("guide-restarted-save");
  await d.click(
    "Remove saved search",
    "document.querySelector('section button[aria-label=\"Remove Weekly\"]')",
  );
  await d.wait(async () => !(await d.exists(button("Weekly"))));
  await d.click("Any day", button("Any day"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);

  const labels = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[data-guide-row]')].map(e=>e.getAttribute('aria-label'))",
  );

  expect(
    labels.some((s) => s.includes("S2 E4") && s.includes("Shown before")),
    "Valid optional episode metadata is visible",
  );
  expect(
    labels.some((s) => !s.includes("S2 E4")),
    "Missing/malformed episode metadata does not hide programme",
  );
  d.observed.episodeLabels = labels;
  await d.click("Focus field for keyboard", field);
  await d.key("ArrowDown", 40);
  await d.key("End", 35);
  expect(
    await d.exists(
      "document.activeElement === [...document.querySelectorAll('[data-guide-row]')].at(-1)",
    ),
    "End reaches final row",
  );
  await d.key("Home", 36);
  await d.key("Enter", 13);
  await d.capture("guide-row-detail");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(`${field} === document.activeElement`));
  await d.key("Escape", 27);
  await d.wait(() => d.exists(`${field}?.value === ''`));
  await d.key("Escape", 27);
  await d.wait(() => d.exists("document.activeElement?.matches('[data-guide-search-opener]')"));
  d.observed.escapeRestoresOpener = true;

  for (const type of ["rawKeyDown", "keyUp"])
    await d.send("Input.dispatchKeyEvent", {
      type,
      key: "k",
      code: "KeyK",
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    });
  await d.wait(() => d.exists("document.querySelector('[role=dialog] input[role=combobox]')"));
  await d.send("Input.insertText", { text: "Weekly" });
  await d.wait(() => d.exists("document.querySelector('[data-guide-search]')"));
  await d.capture("palette-guide-last-row");
  await d.click("Palette guide search", "document.querySelector('[data-guide-search]')");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  expect(await d.exists(`${field}.value === 'Weekly'`), "Palette preserves typed words");
  d.observed.paletteSeed = "Weekly";
  await d.capture("guide-from-palette");

  for (const locale of ["en_US", "nl_NL", "fr_FR", "de_DE", "es_ES"]) {
    await d.quit();
    await d.launch(locale);
    await d.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Text enlargement is a rendering probe; application state still changes through controls.
    await d.evaluate("document.documentElement.style.fontSize = '125%'");

    const language = await d.evaluate<"en-US" | "nl-NL" | "fr-FR" | "de-DE" | "es-ES">(
      "document.documentElement.lang",
    );

    await d.click("Open localized Live TV", named("header button", translate(language, "Live TV")));
    await d.click(
      "Localized header calendar",
      "document.querySelector('[data-guide-search-opener]')",
    );
    await search("Weekly");
    await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
    d.observed[`layout-${locale}`] = await d.evaluate(
      `({lang:document.documentElement.lang, width:innerWidth,height:innerHeight, font:getComputedStyle(document.documentElement).fontSize, buttons:[...document.querySelectorAll('section button')].map(e=>({text:e.textContent,label:e.getAttribute('aria-label'),disabled:e.disabled,rect:e.getBoundingClientRect().toJSON()}))})`,
    );
    await d.capture(`guide-${locale}-960-text125`);
  }
}
