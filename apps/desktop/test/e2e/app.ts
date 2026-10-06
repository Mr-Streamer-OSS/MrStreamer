// Drives a built app over the DevTools protocol, against the fake provider or the fake playlist
// host. Shared by the tests of a built app and the measuring script.
import { spawn, type ChildProcess } from "node:child_process";
import type { FakeProvider } from "../fake-provider.ts";

/** Starts the app with remote debugging on `port` and its data in `profile`. */
export function launch(
  executable: string,
  args: readonly string[],
  options: { port: number; profile: string },
): ChildProcess {
  return spawn(
    executable,
    [`--remote-debugging-port=${options.port}`, `--user-data-dir=${options.profile}`, ...args],
    // No automatic update checks and no TMDB, a closed port unless the caller serves one: both
    // would reach the network in the middle of a measurement.
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_TMDB_API: process.env["MR_STREAMER_TMDB_API"] ?? "http://127.0.0.1:9/3",
      },
    },
  );
}

export type Page = Awaited<ReturnType<typeof connect>>;

/**
 * A minimal DevTools protocol client for the app's window, or for its main process ("node") when
 * the app was started with `--inspect=<port>`.
 */
export async function connect(port: number, kind: "page" | "node" = "page") {
  let url: string | undefined;
  for (let attempt = 0; attempt < 150 && !url; attempt++) {
    await delay(200);
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      url = targets.find((target) => target.type === kind)?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!url)
    throw new Error(`The app opened no ${kind === "page" ? "window" : "inspector"} within 30 s.`);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  const listeners = new Map<string, (params: unknown) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else if (message.method) listeners.get(message.method)?.(message.params);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => resolve({ error: `${method} timed out` }), 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    /** Calls `listener` with each event of this name, as `Fetch.requestPaused`. */
    on(method: string, listener: (params: unknown) => void): void {
      listeners.set(method, listener);
    },
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return (reply.result as { result: { value: T } }).result.value;
    },
    close: () => socket.close(),
  };
}

/** Connects the fake provider through the login form and waits for the channels. */
export async function login(page: Page, provider: FakeProvider): Promise<void> {
  await waitFor(() =>
    page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
  );
  await submit(page, [provider.url, "demo", "demo"]);
}

/**
 * Connects a playlist by its link, through the Connect screen's M3U link field, and waits for
 * the channels. The screen may already ask for the link alone, as when its keychain lost it.
 */
export async function connectPlaylist(page: Page, link: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('form input')"));
  await page.evaluate(
    `[...document.querySelectorAll("form button")].find((b) => b.textContent.trim() === "Use an M3U link")?.click()`,
  );
  await waitFor(() =>
    page.evaluate<boolean>("document.querySelectorAll('form input').length === 1"),
  );
  await submit(page, [link]);
}

/** Types `fields` into the Connect screen's fields, in order, connects, and waits for the app. */
async function submit(page: Page, fields: readonly string[]): Promise<void> {
  await fill(page, fields);
  await waitFor(() =>
    page.evaluate<boolean>(
      "!!document.querySelector('header') && !document.body.innerText.includes('Loading channels')",
    ),
  );
}

/**
 * Types `fields` into the fields of the form the window shows, in order, and sends it. A field
 * past the last of them is left as it is.
 */
export async function fill(page: Page, fields: readonly string[]): Promise<void> {
  await page.evaluate(`(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const fields = ${JSON.stringify(fields)};
    document.querySelectorAll("form input").forEach((input, index) => {
      if (fields[index] === undefined) return;
      setValue.call(input, fields[index]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    document.querySelector('form button[type="submit"]').click();
  })()`);
}

/** Opens Settings > Subscriptions, where the saved subscriptions are listed. */
export async function openSubscriptions(page: Page): Promise<void> {
  await press(page, "Settings");
  const tab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "Subscriptions")`;
  await waitFor(() => page.evaluate<boolean>(`!!${tab}`), 20_000);
  await page.evaluate(`${tab}.click()`);
}

/** The row of the subscription listed as `name` in Settings > Subscriptions, for the page. */
export const subscriptionRow = (name: string): string =>
  `[...document.querySelectorAll("li")].find((row) => row.querySelector("button")?.textContent.trim().startsWith(${JSON.stringify(`${name} · `)}))`;

/**
 * Adds the fake provider beside the saved subscriptions, through Settings > Subscriptions and
 * under `name`, and waits for its row. Settings stays open on the list.
 */
export async function addSubscription(
  page: Page,
  provider: FakeProvider,
  name: string,
): Promise<void> {
  await openSubscriptions(page);
  await press(page, "Add subscription");
  await waitFor(
    () => page.evaluate<boolean>("document.querySelectorAll('form input').length >= 4"),
    20_000,
  );
  await fill(page, [name, provider.url, "demo", "demo"]);
  await waitFor(() => page.evaluate<boolean>(`!!${subscriptionRow(name)}`), 30_000);
}

/** The DevTools protocol's bits for the keys held with another, or with a click. */
/** `main` is the one the app's shortcuts take: ⌘ on macOS, Ctrl elsewhere. */
export const MODIFIERS = {
  alt: 1,
  shift: 8,
  main: process.platform === "darwin" ? 4 : 2,
} as const;

/** Presses a key in the window, with `modifiers` held: a sum of `MODIFIERS`. */
export async function key(page: Page, name: string, code: number, modifiers = 0): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
      modifiers,
    });
  }
}

/** Whether the window shows `words`, in the element `selector` names or anywhere. */
export const says =
  (page: Page, words: string, selector = "body") =>
  async () =>
    (
      await page.evaluate<string>(
        `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`,
      )
    ).includes(words);

/** Clicks the button whose text starts with `label`, or that has it as its label, once there is one. */
export async function press(page: Page, label: string): Promise<void> {
  const button = `[...document.querySelectorAll("button")].find((b) =>
    b.textContent.trim().startsWith(${JSON.stringify(label)}) ||
    b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
  await waitFor(() => page.evaluate<boolean>(`!!${button}`), 20_000);
  await page.evaluate(`${button}.click()`);
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${check.toString()}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
