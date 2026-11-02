// Every page runs website analytics (analytics.ts). Home moves; download and about keep release
// links current:
// - Each part comes in once as it scrolls into view. Nothing runs while the page sits still.
//   styles.css holds the keyframes and switches them off for reduced motion.
// - The five tricks light the row in the middle of the screen; the screens become tabs. Without
//   scripts every trick is lit and every screen shows.
// - One request for the update feed points the download and about pages' links at a stable
//   release published since the site was built (downloads.ts). Home links /download and holds no
//   installer, so it doesn't ask. Without an answer the built links stand.
// - A link into a document page's collapsed section opens that section.
import { startSiteAnalytics, type SiteCapture } from "./analytics.ts";
import { FEED, showFeedDownloads } from "./downloads.ts";

/** Written by vite.config.ts: null unless the build named a capture endpoint and key. */
declare const __SITE_ANALYTICS__: SiteCapture | null;

startSiteAnalytics(__SITE_ANALYTICS__);

const calm = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * The parts that are `revealed` right now, each with the run that revealed it. A part carries
 * the class, and the will-change it brings, only while its animations run.
 */
const playing = new Map<Element, symbol>();

/** Ends a part's motion where it stands. Its animations are dropped with the class. */
const settle = (part: Element): void => {
  playing.delete(part);
  part.classList.remove("revealed");
};

/**
 * Runs a part's animations once, from where their keyframes start to where the part rests, and
 * settles it once every one of them has finished or was dropped.
 * A run that was settled meanwhile, by leaving the screen or hiding the page, leaves it be.
 */
async function play(part: Element): Promise<void> {
  if (calm.matches) return;
  const run = Symbol("run");
  playing.set(part, run);
  part.classList.add("revealed");
  await Promise.allSettled(part.getAnimations({ subtree: true }).map(({ finished }) => finished));
  if (playing.get(part) === run) settle(part);
}

// What is on screen when the page opens stays as it is: only what scrolls in later comes in, and
// once. A part stays watched, so leaving the screen mid-run settles it where it stands.
let opening = true;
const entered = new WeakSet<Element>();
const reveal = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) {
        if (playing.has(target)) settle(target);
        continue;
      }
      if (entered.has(target)) continue;
      entered.add(target);
      if (!opening) void play(target);
    }
    opening = false;
  },
  // A little before it shows, so it never appears and then starts over.
  { rootMargin: "0px 0px 10% 0px" },
);
for (const part of document.querySelectorAll("[data-reveal]")) reveal.observe(part);

// Hiding the page, or asking for less motion halfway, leaves nothing mid-animation.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const part of [...playing.keys()]) settle(part);
});
calm.addEventListener("change", () => {
  for (const part of [...playing.keys()]) settle(part);
});

// The trick nearest the middle of the screen is lit, the others dimmed. It is worked out once a
// frame while the page scrolls, and only while the tricks are on screen, so nothing runs at rest.
const tricks = document.querySelector(".tricks");
if (tricks) {
  tricks.classList.add("watching");
  const rows = [...tricks.querySelectorAll(".trick")];
  let frame = 0;
  const light = (): void => {
    frame = 0;
    const distances = rows.map((row) => {
      const { top, bottom } = row.getBoundingClientRect();
      return Math.abs((top + bottom) / 2 - innerHeight / 2);
    });
    const at = distances.indexOf(Math.min(...distances));
    rows.forEach((row, index) => {
      row.classList.toggle("lit", index === at);
      // Rows above the lit one: their cards leave upward and come back down from above.
      row.classList.toggle("past", index < at);
    });
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(light);
  };
  light();
  // A batch can hold more than one change for the tricks; the last is where they are now.
  new IntersectionObserver((entries) => {
    if (entries.at(-1)?.isIntersecting) {
      addEventListener("scroll", schedule, { passive: true });
      addEventListener("resize", schedule);
      schedule();
    } else {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
    }
  }).observe(tricks);
}

// The screens as tabs: one shows at a time. Arrow keys move along the tabs, as tabs do.
const tablist = document.querySelector<HTMLElement>(".tabs");
if (tablist) {
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (chosen: HTMLButtonElement, focus = false): void => {
    for (const tab of tabs) {
      const on = tab === chosen;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !on;
    }
    if (focus) chosen.focus();
  };
  tablist.addEventListener("click", ({ target }) => {
    const tab =
      target instanceof Element ? target.closest<HTMLButtonElement>('[role="tab"]') : null;
    if (tab) select(tab);
  });
  tablist.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    const next = step === undefined ? undefined : tabs.at((current + step) % tabs.length);
    if (!next) return;
    event.preventDefault();
    select(next, true);
  });
  // Panels hold only pictures, so each takes focus itself, as a tab panel does.
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    panel?.setAttribute("role", "tabpanel");
    if (panel) panel.tabIndex = 0;
  }
  const [first] = tabs;
  if (first) select(first);
  tablist.hidden = false;
}

/** Shows the stable release the update feed names now. Without an answer the built links stand. */
async function refreshDownloads(): Promise<void> {
  try {
    const response = await fetch(FEED, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) showFeedDownloads(document, await response.json());
  } catch {
    // Offline, blocked or not a feed.
  }
}

// Download and about refresh through the same feed contract. Home has neither mark, so it doesn't.
if (document.querySelector("[data-installer], [data-release-version]")) void refreshDownloads();

// Document pages keep their detail in collapsed sections. A link to a section, a question or
// anything inside one opens it, also when the address changes on the same page. Without scripts
// the link still lands on the section's heading, which opens with a click.
function openLinked(): void {
  let id = location.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed address names no section.
  }
  const target = id ? document.getElementById(id) : null;
  // An old fragment's anchor sits in a run of anchors right above its section.
  let next = target?.nextElementSibling;
  while (next instanceof HTMLAnchorElement && !next.href) next = next.nextElementSibling;
  const section = target?.closest("details") ?? (next instanceof HTMLDetailsElement ? next : null);
  if (!target || !section || section.open) return;
  section.open = true;
  target.scrollIntoView();
}
openLinked();
addEventListener("hashchange", openLinked);
