// Every page counts its view. The home page also moves, and the reader starts all of it: each
// feature's name and window rise in once as they scroll into view, and the hero's window tips
// upright as the page scrolls. Nothing runs while the page sits still, and nothing is hidden
// waiting for this script: without it the page is whole and the window upright. styles.css holds
// the keyframes and switches them off for reduced motion.
import { inject } from "@vercel/analytics";

// Local development does not load the analytics script.
if (import.meta.env.PROD) inject({ mode: "production" });

/** The full layout, for someone who hasn't asked for less motion. Either can change while open. */
const tilting = matchMedia("(min-width: 70em) and (prefers-reduced-motion: no-preference)");
const calm = matchMedia("(prefers-reduced-motion: reduce)");

// Only the home page has the window. The other pages listen for nothing.
const hero = document.querySelector<HTMLElement>("[data-tilt]");
if (hero) {
  let queued = false;

  /**
   * Sets how upright the hero's window stands, from 0 as its top enters at the foot of the screen
   * to 1 once it is a fifth of the way from the top.
   */
  const tilt = (): void => {
    queued = false;
    if (!tilting.matches) return void hero.style.removeProperty("--tilt");
    const { top, bottom } = hero.getBoundingClientRect();
    if (bottom < 0 || top > innerHeight) return;
    const upright = Math.min(Math.max((innerHeight - top) / (innerHeight * 0.8), 0), 1);
    hero.style.setProperty("--tilt", upright.toFixed(3));
  };

  /** One update per frame, and only after the reader scrolled, resized or changed a preference. */
  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tilt);
  };

  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  tilting.addEventListener("change", queue);
  tilt();
}

// What is on screen when the page opens stays as it is: only what scrolls in later rises.
let opening = true;
const reveal = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      reveal.unobserve(target);
      if (opening || calm.matches) continue;
      target.classList.add("revealed");
      target.addEventListener("animationend", () => target.classList.remove("revealed"), {
        once: true,
      });
    }
    opening = false;
  },
  // A little before it shows, so it never appears and then starts over.
  { rootMargin: "0px 0px 10% 0px" },
);
for (const element of document.querySelectorAll("[data-reveal]")) reveal.observe(element);
