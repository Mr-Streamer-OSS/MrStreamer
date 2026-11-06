// Run the built desktop on an isolated fake-provider profile: Close must release the renderer,
// finish the runnable queue and exit on Windows/Linux. A paused queue must exit without resuming.
import { type } from "arktype";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ownedRun, type Started } from "./downloads-run.ts";
import { pictureServer } from "./downloads-queue.ts";
import { electronExecutable } from "./session.ts";
import { SOURCE_LOCALE } from "../../../../packages/contracts/src/language.ts";
import { setLanguage, t } from "../../../../packages/core/src/i18n.ts";

export async function runDownloadsBackground(
  build: Record<string, unknown> & { executable: string },
) {
  if (process.platform === "darwin") throw new Error("Automatic exit is a Windows/Linux journey.");
  setLanguage({ locale: SOURCE_LOCALE, formats: SOURCE_LOCALE });
  let started: Started | undefined;
  const observed: Record<string, unknown> = {};
  await ownedRun(
    {
      build,
      style: "series",
      watchWindow: true,
      prefix: "downloads-background-",
      observed,
      pictures: pictureServer,
      driver: (_page, base) => base,
      describe: (instance) => {
        started = instance;

        return { ...instance };
      },
      proof: { scenario: "downloads-background", build },
      limits: [
        "Linux fake-provider source journey only. Native tray input, OS wakefulness, manual sleep, macOS and Windows require separate native proof. Explicit Quit dialog is verified after designer integration.",
      ],
      done: "downloads-background",
    },
    async ({ start, provider, profile, action }) => {
      const button = (selector: string, words: string) =>
        `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;

      const first = provider.titles.movies.find((movie) =>
        movie.name.startsWith("TEST | Two sound tracks"),
      );

      const second = provider.titles.movies.find((movie) =>
        movie.name.startsWith("TEST | Old AVI"),
      );

      if (!first || !second) throw new Error("Missing fixture movies.");
      provider.stallMovieFile(first.id, 200_000, 120_000);
      provider.stallMovieFile(second.id, 200_000, 4000);
      let d = await start("runnable queue");
      await d.wait(() =>
        d.page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
      );

      for (const [index, value] of [provider.url, "demo", "demo"].entries()) {
        await d.click(
          `Connect field ${index + 1}`,
          `document.querySelectorAll('form input')[${index}]`,
        );
        await d.page.send("Input.insertText", { text: value });
      }

      await d.click("Connect", "document.querySelector('form button[type=submit]')");
      await d.wait(() => d.exists("document.querySelector('header')"));

      for (const movie of [first, second]) {
        await d.click("Movies", button("header button", t("Movies")));
        await d.click("All movies", button("nav button", t("All movies")));
        const name = movie.name.replace(/^TEST \| /, "").replace(/ \(.*$/, "");
        await d.click(
          "Movie details",
          `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(name)}))`,
        );
        await d.click("Download", button('[role="dialog"] button', t("Download")));
        await d.wait(async () => /%|Queued/.test(await d.text('[role="dialog"]')));
        await d.key("Escape", 27);
      }

      await d.click("Downloads", button("header button", t("Downloads")));
      await d.click("Pause all", button("button", t("Pause all")));
      await d.wait(() => d.exists(button("button", t("Resume all"))));
      await d.capture("paused-before-close");
      const pausedInstance = started;

      if (!pausedInstance?.pid) throw new Error("Missing paused process identity.");
      action("Close with only paused downloads");
      await d.page.send("Page.close").catch(() => undefined);
      await d.wait(async () => {
        try {
          process.kill(pausedInstance.pid!, 0);

          return false;
        } catch {
          return true;
        }
      });
      observed["pausedOnlyExited"] = true;
      d = await start("resume runnable queue");
      await d.wait(() => d.exists("document.querySelector('header')"));
      await d.click("Downloads", button("header button", t("Downloads")));
      await d.wait(() => d.exists(button("button", t("Resume all"))));
      provider.stallMovieFile(first.id, 400_000, 4000);
      await d.click("Resume all", button("button", t("Resume all")));
      await d.wait(() => d.exists(button("button", t("Pause all"))));
      await d.capture("before-close");
      const instance = started;

      if (!instance?.pid) throw new Error("No verified process identity.");
      action("Close the window, leaving the queue running");
      await d.page.send("Page.close").catch(() => undefined);

      const alive = () => {
        try {
          process.kill(instance.pid!, 0);

          return true;
        } catch {
          return false;
        }
      };

      await d.wait(async () => {
        const targets = type({ type: "string" })
          .array()
          .assert(await (await fetch(`http://127.0.0.1:${instance.port}/json/list`)).json());

        return alive() && targets.every((target) => target.type !== "page");
      });
      observed["closedRendererWhileAlive"] = true;
      await d.wait(async () => !alive(), 30_000);
      const folders = await readdir(join(profile, "downloads"));

      if (folders.length !== 2) throw new Error("Both queued copies must finish after Close.");

      for (const folder of folders) {
        const files = await readdir(join(profile, "downloads", folder));

        if (!files.some((file) => file.startsWith("media.") && !file.endsWith(".part")))
          throw new Error("Close interrupted a runnable copy.");
      }

      observed["completedAfterClose"] = folders.length;
    },
  );
}

// Standalone entry point keeps the shared control helper outside this ticket's ownership.
if (process.argv[1]?.endsWith("downloads-background.ts")) {
  const main = await readFile(
    new URL("../../../../apps/desktop/out/main/index.js", import.meta.url),
  );

  await runDownloadsBackground({
    executable: await electronExecutable(),
    mainSha256: createHash("sha256").update(main).digest("hex"),
  });
}
