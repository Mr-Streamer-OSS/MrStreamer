## Evidence runs

A built-app evidence run proves a ticket's journeys in the built Linux window. Before its first launch:

1. From the checkout's root: `pnpm install --frozen-lockfile`, `pnpm build`, `xvfb-run -a pnpm verify:desktop doctor`. When Electron's download is missing, doctor prints the `node …/install.js` command that fetches it; run it and doctor again.
2. Run the scenario or journey that the feature entry names. For a path none drives, write a **journey module** in `.local/<ticket>/` and run it with `xvfb-run -a pnpm verify:desktop journey <module>`.
3. Check the module against every cause below. Each one stopped an earlier run.

### Journey modules

The runner starts this checkout's build on a fresh profile, logs in on the fake provider with fake TMDB, then calls the module's default export, a `Journey` from [journey.ts](../scripts/journey.ts). Its proof, screenshots and cleanup are a scenario's ([Evidence](evidence.md)). [people.ts](../scripts/people.ts) is a worked example.

```ts
import type { Journey } from "/abs/checkout/.cursor/skills/verify-mrstreamer/scripts/journey.ts";

const journey: Journey = async (d, { provider, tmdb, named, poster, dialog, focused }) => {
  await d.click("Open Movies", named("header button", "Movies"));
  await d.click("Open All movies", named("nav button", "All movies"));
  await d.click("Open Two sound tracks", poster("Two sound tracks"));
  await d.wait(() => d.exists(named("button", "Alan Actor", dialog)));
  await d.capture("details");
  d.observed["about"] = tmdb.aboutRequests();
};

export default journey;
```

The module's imports are type imports, so nothing resolves from `.local/`. Everything it drives comes through `d` (the `Driver` in [language.ts](../scripts/language.ts)) and the kit: the fake `provider` and `tmdb` with their request counters, and the selectors.

### Named causes

| Cause                                                                      | Seen in                                    | What the run does                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron's download missing (`path.txt`)                                   | #875, #880                                 | Runs the `install.js` command doctor prints.                                                                                                                                                                                                                                                                                                                                         |
| A package import from `.local/` (`ERR_MODULE_NOT_FOUND`)                   | #880, #884                                 | Writes a journey module with type imports only.                                                                                                                                                                                                                                                                                                                                      |
| A CDP reply envelope read as its result                                    | #888                                       | Uses `d.send`, which returns the result and throws a CDP error, and `d.capture` for screenshots.                                                                                                                                                                                                                                                                                     |
| A browser-window command on the page socket (`Browser.getWindowForTarget`) | #888                                       | Sizes the window with `Emulation.setDeviceMetricsOverride` through `d.send`, as [controls.ts](../scripts/controls.ts) does.                                                                                                                                                                                                                                                          |
| A GUI session id parsed by hand from `fleet-gui` output                    | #888                                       | Runs under `xvfb-run -a`; the runner owns the app, fixtures and cleanup.                                                                                                                                                                                                                                                                                                             |
| A provider name awaited where TMDB's name shows                            | #861, #875, #888                           | Opens grid posters with `poster(words)`, which reads the provider name kept in the poster's title. Shown names follow `tmdbName` in `apps/desktop/test/fake-tmdb.ts`: id 100000 shows Original 100000, 100002 English 100002, 100005 Origineel 100005. Linked lists' posters carry no provider name: `named("li button", shownName, dialog)`.                                        |
| Decorative text in `textContent` (initials before a cast name)             | #875                                       | Uses `named`, which reads the aria-label, else the words outside aria-hidden parts, and matches the name or its start up to a word's end.                                                                                                                                                                                                                                            |
| A control named by its aria-label searched in `innerText`                  | #853                                       | Uses `named`.                                                                                                                                                                                                                                                                                                                                                                        |
| Backslashes lost from a regex inside an expression string                  | #853                                       | Puts values in with `JSON.stringify` and writes a regex in `String.raw`, as `journey.ts` does.                                                                                                                                                                                                                                                                                       |
| A selector matching a control beneath the open sheet                       | #862                                       | Scopes with `named(selector, name, dialog)`. A failed `click` says what stopped it: no element matches, hidden, disabled, animating, moving, outside the window, or covered by an element it names.                                                                                                                                                                                  |
| Shift sent as Alt (CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8)      | #862                                       | Passes names: `d.key("Tab", 9, ["shift"])`. The action log reads `Press Shift+Tab`.                                                                                                                                                                                                                                                                                                  |
| A key aimed at a focused button, field or dialog                           | #862 (Escape cleared search), #884 (Space) | Puts the keyboard where a viewer's is first: Space after clicking the player or focusing its target, a sheet closed by its Close or Back button. App shortcuts skip keys aimed at buttons, fields and dialogs. Every `d.key` logs the focused element, as `Press Space (focus: button "Play here")`. The runner's launch also emulates window focus, so Xvfb keeps the page focused. |

Sources and the full cause list are on the ticket card (#889). #862's first two timeouts were never fully diagnosed; the card's plan names dialog selection and the modifier.

After a stop, read `proof.json`'s `error` and last `actions` and the retained `failure.png` before changing the module. Fix the named cause, or add a row here when it is new.
