// The downloads-queue scenario of `pnpm verify:desktop`: Pause, Resume, Up and Down on the
// Downloads page's rows and Pause all in its heading, driven through the built app's window with
// pointer and key input, on one profile started twice. Four movies are queued from their details,
// the first failing at once. The transfer is paused from the keyboard, a queued one moved up from
// the keyboard, the queue paused whole with the pointer and one resumed, then a title of the same
// subscription plays: what was resumed waits for it, what the viewer paused stays paused. The next
// start must find the pauses and the order kept; a paused file the provider replaced starts again
// and says so, Cancel takes a partial file with it. The fake provider counts files sent at once.
//   With `--previous <executable>`, a build from before pauses existed (stable 0.0.19's, as its
// AppImage unpacks) starts on the same profile between the two: it must read every download,
// transfer the paused ones in the order they were added, which is the limit of going back, and
// keep what this build wrote through its own transfer, retry and progress writes, so the next
// start finds the unfinished ones paused and in their places again.
//   Main's connections are recorded by network-hook.cjs for this build's starts; the window of
// either build resolves no host but loopback. Proof stays in `.local/verification/`.
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { fixture } from "../../../../apps/desktop/test/fake-provider.ts";
import { SOURCE_LOCALE } from "../../../../packages/contracts/src/language.ts";
import { setLanguage, t } from "../../../../packages/core/src/i18n.ts";
import { now, ownedRun, type BaseDriver, type Run } from "./downloads-run.ts";
import { injectedFailure } from "./session.ts";

/** A download as main lists it to the window: read as an observation, never changed. */
interface Listed {
  readonly id: string;
  readonly status: { readonly kind: string; readonly received?: number };
  readonly progress: { readonly position: number } | null;
  readonly title: { readonly kind: string; readonly id: string };
}

/** Window driving for this scenario; observations read the DOM or main's list. */
const driver = (page: Page, base: BaseDriver) => {
  const video = () =>
    page.evaluate<{ time: number; width: number; paused: boolean; title: boolean }>(`(() => {
        const v = document.querySelector('video');
        return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, paused: v?.paused ?? true,
          title: !!document.querySelector('[data-view=title]') };
      })()`);
  const listed = () =>
    page.evaluate<Listed[]>(
      "window.mrStreamer.invoke('downloads.list').then(r => r.ok ? r.value.items : [])",
    );
  /** The download rows in the order the page draws them. */
  const rows = () =>
    page.evaluate<string[]>(
      "[...document.querySelectorAll('[data-download]')].map(r => r.dataset.download)",
    );
  /** What has the keyboard: its aria-label, else its words. */
  const focused = () =>
    page.evaluate<string | null>(
      "document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? null",
    );
  return { ...base, video, listed, rows, focused };
};
type Driver = ReturnType<typeof driver>;

export async function runDownloadsQueue(
  build: Record<string, unknown> & { executable: string },
  previous?: string,
) {
  setLanguage({ locale: SOURCE_LOCALE, formats: SOURCE_LOCALE });
  const steps = async ({
    start,
    quit,
    action,
    observed,
    provider,
    profile,
    abort,
  }: Run<Driver>) => {
    const ownedProvider = provider;

    const button = (selector: string, words: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const poster = (words: string) =>
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(words)}))`;
    const row = (id: string) => `document.querySelector('[data-download="${id}"]')`;
    const inRow = (id: string, words: string) =>
      `[...(${row(id)})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const hold = (id: string) => `(${row(id)})?.querySelector('[data-hold]')`;
    const arrow = (id: string, by: -1 | 1) => `(${row(id)})?.querySelector('[data-move="${by}"]')`;
    const notice = () =>
      `document.querySelector(${JSON.stringify(`header [aria-label^="${t("Downloads, {status}", { status: "" })}"]`)})`;
    const statuses = async (d: Driver) =>
      Object.fromEntries((await d.listed()).map((item) => [item.id, item.status]));
    const statusOf = async (d: Driver, id: string) =>
      (await d.listed()).find((item) => item.id === id)?.status;
    const openDownloads = async (d: Driver) => {
      await d.click("Open Downloads", button("header button", t("Downloads")));
      await d.wait(() =>
        d.exists(`document.querySelector('h1')?.textContent === ${JSON.stringify(t("Downloads"))}`),
      );
    };
    const movies = ownedProvider.titles.movies;
    const named = (words: string) => {
      const found = movies.find((each) => each.name.startsWith(words));
      if (!found) throw new Error(`No movie ${words}`);
      return found;
    };
    const missing = named("TEST | Missing file");
    const first = named("TEST | Two sound tracks and subtitles (MULTI)");
    const second = named("TEST | Old AVI");
    const third = named("TEST | Long subtitles");
    const idOf = async (d: Driver, movieId: number) => {
      const found = (await d.listed()).find((item) => item.title.id === String(movieId));
      if (!found) throw new Error(`No download of movie ${movieId}`);
      return found.id;
    };
    /** A copy's file in the run's profile, by its SHA-256: an observation of the disk. */
    const copyDigest = async (id: string) => {
      const folder = join(profile!, "downloads", id);
      const media = (await readdir(folder)).find(
        (name) => name.startsWith("media.") && !name.endsWith(".part"),
      );
      if (!media) return null;
      return createHash("sha256")
        .update(await readFile(join(folder, media)))
        .digest("hex");
    };
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    // 1. Connect, then queue four movies from their details: the first fails at once, the next
    // transfers, held by the provider, and the other two wait their turn.
    ownedProvider.stallMovieFile(first.id, 200_000, 120_000);
    ownedProvider.stallMovieFile(second.id, 30_000, 120_000);
    ownedProvider.stallMovieFile(third.id, 30_000, 120_000);
    const online = await start("online", { kind: "candidate" });
    await online.wait(() =>
      online.page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    );
    for (const [index, value] of [ownedProvider.url, "demo", "demo"].entries()) {
      await online.click(
        `Fill Connect field ${index + 1}`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await online.page.send("Input.insertText", { text: value });
    }
    await online.click("Submit Connect", "document.querySelector('form button[type=submit]')");
    await online.wait(() => online.exists("document.querySelector('header')"));
    injectedFailure("downloads-queue");
    const queue = async (movie: { readonly name: string }, words: string, until: string) => {
      await online.click("Open Movies", button("header button", t("Movies")));
      await online.click("Open All movies", button("nav button", t("All movies")));
      await online.click(
        `Open ${words}`,
        poster(movie.name.replace(/^TEST \| /, "").replace(/ \(.*$/, "")),
      );
      await online.click(`Download ${words}`, button('[role="dialog"] button', t("Download")));
      await online.wait(async () => (await online.text('[role="dialog"]')).includes(until), 60_000);
      await online.key("Escape", 27);
    };
    await queue(missing, "the missing-file movie", t("Retry"));
    await queue(first, "the two-sound-track movie", "%");
    await queue(second, "the AVI movie", t("Queued"));
    await queue(third, "the long-subtitles movie", t("Queued"));
    await openDownloads(online);
    const [d, a, b, c] = [
      await idOf(online, missing.id),
      await idOf(online, first.id),
      await idOf(online, second.id),
      await idOf(online, third.id),
    ];
    observed["ids"] = { failing: d, first: a, second: b, third: c };
    await online.wait(async () => (await statusOf(online, a))?.received === 200_000);
    await online.capture("queue-transferring");
    if ((await online.rows()).join() !== [a, b, c, d].join())
      throw new Error(`The queue isn't drawn in its order: ${await online.rows()}`);

    // Where the keyboard is and the rows' order, each time either changes: an observation only.
    await online.page.evaluate(`(() => {
      const log = window.__keyboard = [];
      const start = performance.now();
      const at = () => Math.round(performance.now() - start);
      const name = (element) =>
        element ? element.getAttribute('aria-label') ?? element.textContent.trim() : null;
      for (const type of ['focusin', 'focusout'])
        document.addEventListener(type, (event) => log.push([at(), type, name(event.target)]), true);
      new MutationObserver(() => log.push([at(), 'rows',
        [...document.querySelectorAll('[data-download]')].map((row) => row.dataset.download.slice(0, 8))]))
        .observe(document.querySelector('section'), { childList: true });
    })()`);
    const keyboardLog = () => online.page.evaluate<unknown[]>("window.__keyboard ?? []");

    // 2. Pause the transfer from the keyboard: it stops once its request ended, keeps its bytes,
    // and the keyboard stays on its row's control, now Resume, though the row moved.
    await online.tabTo("Tab to the transfer's Pause", hold(a));
    await online.press(" ");
    await online.wait(async () => (await statusOf(online, a))?.kind === "paused");
    await online.wait(async () =>
      (await online.text(`[data-download="${a}"]`)).includes(t("Paused")),
    );
    await online.wait(async () => (await statusOf(online, b))?.received === 30_000);
    const pausedTransfer = {
      status: await statusOf(online, a),
      row: await online.text(`[data-download="${a}"]`),
      keyboard: await online.focused(),
      keyboardOnItsRow: await online.exists(`(${hold(a)}) === document.activeElement`),
      rows: await online.rows(),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    observed["pausedTransfer"] = pausedTransfer;
    if (!pausedTransfer.keyboardOnItsRow || pausedTransfer.keyboard !== t("Resume download"))
      throw new Error(`The keyboard left the paused row: ${JSON.stringify(pausedTransfer)}`);
    await online.capture("transfer-paused-from-keyboard");

    // 3. Move the last one up from the keyboard: past the paused one, to the top of those waiting,
    // where Up goes no further and Down has the keyboard. The transfer under way doesn't stop.
    const asked = ownedProvider.fileRequests();
    await online.tabTo("Tab to the last one's Up", arrow(c, -1));
    await online.press("Enter");
    await online.wait(async () => (await online.rows()).join() === [b, c, a, d].join());
    await online
      .wait(() => online.exists(`(${arrow(c, 1)}) === document.activeElement`), 5000)
      .finally(async () => {
        observed["keyboardLog"] = await keyboardLog().catch(() => null);
      });
    const moved = {
      rows: await online.rows(),
      keyboard: await online.focused(),
      upDisabled: await online.exists(`(${arrow(c, -1)}).disabled`),
      transfer: await statusOf(online, b),
      newFileRequests: ownedProvider.fileRequests() - asked,
    };
    observed["movedFromKeyboard"] = moved;
    if (moved.transfer?.kind !== "transferring" || moved.newFileRequests !== 0)
      throw new Error(`The move stopped the transfer: ${JSON.stringify(moved)}`);
    await online.capture("moved-from-keyboard");

    // 4. Pause all with the pointer: the transfer stops too, the heading offers Resume all, and
    // the top bar on another page says Paused, quietly.
    await online.click("Pause all", button("button", t("Pause all")));
    await online.wait(async () => {
      const now = await statuses(online);
      return [a, b, c].every((id) => now[id]?.kind === "paused") && now[d]?.kind === "failed";
    });
    await online.wait(async () => ownedProvider.activeStreams() === 0, 5000);
    await online.wait(() => online.exists(button("button", t("Resume all"))));
    observed["allPaused"] = { statuses: await statuses(online), rows: await online.rows() };
    await online.capture("all-paused");
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.wait(
      async () =>
        (await online.page.evaluate<string | null>(`(${notice()})?.textContent.trim() ?? null`)) ===
        t("Paused"),
    );
    observed["noticeAllPaused"] = await online.page.evaluate(`(() => {
      const n = ${notice()};
      return { text: n.textContent.trim(), label: n.getAttribute('aria-label'),
        quiet: n.className.includes('text-muted-foreground') };
    })()`);
    await online.capture("notice-paused");
    await openDownloads(online);

    // 5. Resume the one moved first; then play a title of the same subscription: it waits for
    // playback, while the paused ones stay paused, and only one file is sent at a time.
    await online.click("Resume the one moved first", hold(c));
    await online.wait(async () => (await statusOf(online, c))?.received === 30_000);
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the index-at-the-end movie", poster("Index at the end"));
    await online.click(
      "Play it from the same subscription",
      button('[role="dialog"] button', t("Play")),
    );
    await online.wait(async () => {
      const v = await online.video();
      return v.title && !v.paused && v.width > 0 && v.time > 1;
    }, 45_000);
    await online.wait(async () => (await statusOf(online, c))?.kind === "waiting");
    const whilePlaying = {
      statuses: await statuses(online),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
      playback: await online.video(),
    };
    observed["whilePlaying"] = whilePlaying;
    if (![a, b].every((id) => whilePlaying.statuses[id]?.kind === "paused"))
      throw new Error(`Playback changed a pause: ${JSON.stringify(whilePlaying)}`);
    await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
    await delay(400, undefined, { signal: abort.signal });
    await online.capture("paused-and-waiting-while-playing");
    // Held again further on, so it is seen going on once playback ends.
    ownedProvider.stallMovieFile(third.id, 60_000, 120_000);
    await online.key("Escape", 27);
    await online.wait(async () => !(await online.video()).title);
    await online.wait(async () => {
      const status = await statusOf(online, c);
      return status?.kind === "transferring" && status.received === 60_000;
    });
    // Given back, the connection goes to the resumed one only, however long it waits.
    await delay(2000, undefined, { signal: abort.signal });
    const afterPlayback = {
      statuses: await statuses(online),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    observed["afterPlayback"] = afterPlayback;
    if (
      ![a, b].every((id) => afterPlayback.statuses[id]?.kind === "paused") ||
      afterPlayback.mostFilesAtOnce !== 1
    )
      throw new Error(`Playback ending took a paused download: ${JSON.stringify(afterPlayback)}`);
    await quit("online");
    ownedProvider.stallMovieFile(third.id, 80_000, 120_000);

    // Optional: the earlier build on the same profile. It can't know a pause or a place: it reads
    // every download, transfers them in the order added, the paused first one among them, keeps
    // the keys through its writes, retries the failed one and keeps a copy's progress.
    if (previous) {
      ownedProvider.stallMovieFile(second.id, 60_000, 120_000);
      const older = await start("previous", { kind: "previous", executable: previous });
      await older.wait(() => older.exists("document.querySelector('header')"), 60_000);
      await openDownloads(older);
      const read = await older.listed();
      await older.wait(async () => (await statusOf(older, a))?.kind === "complete", 60_000);
      await older.wait(async () => ((await statusOf(older, b))?.received ?? 0) >= 60_000, 60_000);
      const transferred = await statuses(older);
      await older.capture("previous-transfers-in-added-order");
      await older.click("Retry the failed one in the earlier build", inRow(d, t("Retry")));
      await older.wait(async () => (await statusOf(older, d))?.kind !== "failed");
      await older.click(
        "Watch the first copy offline in the earlier build",
        inRow(a, t("Watch offline")),
      );
      await older.wait(async () => {
        const v = await older.video();
        return v.title && !v.paused && v.width > 0 && v.time > 3;
      }, 45_000);
      await older.key("Escape", 27);
      await older.wait(async () => !(await older.video()).title);
      await older.wait(
        async () =>
          ((await older.listed()).find((item) => item.id === a)?.progress?.position ?? 0) > 0,
      );
      observed["previousStart"] = {
        readOnStart: read.map((item) => [item.id, item.status.kind]),
        transferred,
        afterRetryAndPlayback: (await older.listed()).map((item) => [
          item.id,
          item.status,
          item.progress,
        ]),
        rows: await older.rows(),
      };
      await older.capture("previous-after-retry-and-playback");
      await quit("previous");
    }

    // 6. Start again: the pauses and the order are kept. The one moved first goes before the
    // others; a failed one queued again by the earlier build keeps its own place before it.
    const again = await start("again", { kind: "candidate" });
    await again.wait(() => again.exists("document.querySelector('header')"), 60_000);
    await openDownloads(again);
    await again.wait(async () => {
      const status = await statusOf(again, c);
      return status?.kind === "transferring" && status.received === 80_000;
    }, 60_000);
    const restarted = { statuses: await statuses(again), rows: await again.rows() };
    observed["afterRestart"] = restarted;
    if (restarted.statuses[b]?.kind !== "paused")
      throw new Error(`The second one lost its pause: ${JSON.stringify(restarted)}`);
    if (!previous && restarted.statuses[a]?.kind !== "paused")
      throw new Error(`The first one lost its pause: ${JSON.stringify(restarted)}`);
    if (restarted.rows.indexOf(c) > restarted.rows.indexOf(b))
      throw new Error(`The order wasn't kept: ${JSON.stringify(restarted)}`);
    await again.capture("after-restart");

    // 7. Cancel the transfer with the pointer: its row and partial file go.
    await again.click("Cancel the transfer", inRow(c, t("Cancel")));
    await again.wait(async () => !(await again.exists(row(c))));
    const cancelledFolder = await stat(join(profile, "downloads", c)).then(
      () => "kept",
      () => "gone",
    );
    observed["cancelled"] = {
      folder: cancelledFolder,
      listed: (await again.listed()).some((item) => item.id === c),
    };
    if (cancelledFolder !== "gone") throw new Error("Cancel kept the partial file.");

    // 8. The provider replaced the second one's file: resumed from the keyboard, it starts again
    // and says so, and the copy is the new file whole.
    const replacement = fixture("title-long-subs.mkv");
    ownedProvider.replaceMovieFile(second.id, replacement);
    ownedProvider.stallMovieFile(second.id, 30_000, 3000);
    action("Replace the second movie's file at the provider");
    await again.tabTo("Tab to the second one's Resume", hold(b));
    await again.press(" ");
    await again.wait(async () =>
      (await again.text(`[data-download="${b}"]`)).includes(t("started again, the file changed")),
    );
    await again.capture("resumed-file-changed");
    await again.wait(async () => (await statusOf(again, b))?.kind === "complete", 60_000);
    observed["changedFile"] = {
      copy: await copyDigest(b),
      replacement: digest(replacement),
    };
    if ((observed["changedFile"] as { copy: string | null }).copy !== digest(replacement))
      throw new Error("The resumed copy isn't the provider's new file.");

    // 9. What is left: the first one resumed when still paused, the failed one deleted.
    if ((await statusOf(again, a))?.kind === "paused") {
      ownedProvider.stallMovieFile(first.id, Number.MAX_SAFE_INTEGER, 0);
      await again.click("Resume the first one", hold(a));
    }
    await again.wait(async () => (await statusOf(again, a))?.kind === "complete", 60_000);
    await again.wait(async () => (await statusOf(again, d))?.kind === "failed", 60_000);
    await again.click("Delete the failed one", inRow(d, t("Delete")));
    await again.wait(async () => !(await again.exists(row(d))));
    observed["final"] = {
      statuses: await statuses(again),
      firstCopy: await copyDigest(a),
      firstFile: digest(fixture(first.fixture!)),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    await again.capture("final");
    if (
      (observed["final"] as { firstCopy: string | null }).firstCopy !==
      digest(fixture(first.fixture!))
    )
      throw new Error("The first copy isn't the provider's file.");
    if (ownedProvider.mostFilesAtOnce() !== 1)
      throw new Error("The provider sent two files at once.");
    await quit("again");
  };
  await ownedRun(
    {
      build,
      style: "builds",
      watchWindow: false,
      prefix: previous ? "downloads-queue-previous-" : "downloads-queue-",
      observed: { build },
      pictures: pictureServer,
      driver,
      describe: ({ label, which, executable, pid, port, profile, url }) => ({
        label,
        build: which.kind,
        executable,
        pid,
        port,
        profile,
        url,
        at: now(),
      }),
      prepare: async (observed) => {
        if (previous) {
          const executable = previous;
          await access(executable);
          const asar = await readFile(join(dirname(executable), "resources/app.asar"));
          observed["previous"] = {
            executable,
            appAsarSha256: createHash("sha256").update(asar).digest("hex"),
            // What the earlier build's record knows: no pause or place among its keys.
            declaresPausedAt: asar.includes("pausedAt"),
            states: asar.includes("'queued' | 'failed' | 'complete'"),
          };
        }
      },
      proof: { scenario: "downloads-queue", build, previous: previous ?? null },
      limits: [
        "A receiver taking the connection is covered by the service tests, not this window",
        "Main's connections are recorded for this build's starts only; a packaged earlier build takes no --require",
      ],
      done: "downloads-queue",
    },
    steps,
  );
}

/** Answers every path with the same small picture, as an artwork CDN would. */
export async function pictureServer(): Promise<Server> {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk2PH/PwAFTgKWx2D3tQAAAABJRU5ErkJggg==",
    "base64",
  );
  const server = createServer((_request, response) =>
    response.writeHead(200, { "Content-Type": "image/png" }).end(png),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
