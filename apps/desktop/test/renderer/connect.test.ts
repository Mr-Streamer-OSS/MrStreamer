// @vitest-environment happy-dom
// The Connect screen: an address without a scheme goes to https first, and the login goes over
// plain http only after the viewer agrees. An address typed with http:// says so under the field.
// When the keychain no longer gives back what it kept, the screen asks for that again: the
// password of a login, with the rest filled in, or the link of a playlist, of which it can name
// only the host.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { ConnectScreen } from "../../src/renderer/src/features/connect/ConnectScreen.tsx";

let unmount = () => {};
afterEach(() => unmount());

/**
 * Does `step`, then waits for what it set off: React Query tells the screen about a mutation's
 * changes in a timer of its own, set once the answer has gone through a few promises.
 */
async function settled(step: () => unknown): Promise<void> {
  await act(async () => {
    step();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The screen in the page, for a first login or for `existing`. */
async function connectScreen(existing: SubscriptionSummary | null = null): Promise<HTMLElement> {
  ipc.reset();
  const container = document.createElement("div");
  // In the page, as a field takes focus only there.
  document.body.append(container);
  const root = createRoot(container);
  await settled(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ConnectScreen, { existing }),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

/** A subscription whose keychain no longer gives back its password or its link. */
const locked = (
  subscription: Pick<SubscriptionSummary, "kind" | "id" | "server" | "username">,
): SubscriptionSummary => ({
  ...subscription,
  account: { state: "active", expiresAt: null, maxConnections: null, activeConnections: null },
  needsSecret: true,
});

/** The field the screen put the cursor in, by its label. */
const focused = () => document.activeElement?.closest("label")?.firstChild?.textContent;

/** Types into the login form's fields, in order: server, username, password. */
function type(screen: HTMLElement, values: readonly string[]): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  return settled(() =>
    screen.querySelectorAll("input").forEach((input, index) => {
      setValue?.call(input, values[index] ?? "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  );
}

const button = (screen: HTMLElement, text: string) =>
  [...screen.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

const click = (screen: HTMLElement, text: string) => settled(() => button(screen, text)?.click());

/** Presses Connect, and answers that the address has no https. */
async function connectWithoutHttps(screen: HTMLElement): Promise<void> {
  const answer = ipc.hold("subscription.connect");
  await settled(() =>
    screen
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settled(() =>
    answer.reject({ kind: "unencrypted-only", server: "https://line.example.tv:8080" }),
  );
}

const UNENCRYPTED = "Not encrypted. Your login travels as plain text.";

describe("connecting", () => {
  it("asks before sending the login over http when https doesn't work", async () => {
    const screen = await connectScreen();
    await type(screen, ["line.example.tv:8080", "demo", "s3cret"]);
    await connectWithoutHttps(screen);

    expect(ipc.argsOf("subscription.connect")).toEqual([
      { server: "line.example.tv:8080", username: "demo", password: "s3cret" },
    ]);
    expect(screen.textContent).toContain("line.example.tv has no encrypted connection.");
    expect(button(screen, "Connect")).toBeUndefined();

    ipc.hold("subscription.connect");
    await click(screen, "Connect without encryption");

    expect(ipc.argsOf("subscription.connect").at(-1)).toEqual({
      server: "http://line.example.tv:8080",
      username: "demo",
      password: "s3cret",
    });
    expect(screen.textContent).toContain(UNENCRYPTED);
  });

  it("goes back to the form when the viewer doesn't agree", async () => {
    const screen = await connectScreen();
    await type(screen, ["line.example.tv:8080", "demo", "s3cret"]);
    await connectWithoutHttps(screen);

    await click(screen, "Cancel");

    expect(button(screen, "Connect")).toBeDefined();
    expect(screen.textContent).not.toContain("has no encrypted connection");
    expect(ipc.argsOf("subscription.connect")).toHaveLength(1);
  });

  it.each([
    { server: "http://line.example.tv:8080", line: true },
    { server: "https://line.example.tv", line: false },
    { server: "line.example.tv:8080", line: false },
  ])("says the login travels as plain text for $server: $line", async ({ server, line }) => {
    const screen = await connectScreen();
    await type(screen, [server, "demo", "s3cret"]);

    expect(screen.textContent?.includes(UNENCRYPTED)).toBe(line);
  });
});

describe("a keychain that no longer gives back what it kept", () => {
  it("asks for a playlist's link again, naming only the host it came from", async () => {
    const screen = await connectScreen(
      locked({
        kind: "m3u",
        id: "m3u:0123456789abcdef",
        server: "https://iptv.example.com",
        username: "",
      }),
    );

    expect(screen.querySelector("h1")?.textContent).toBe("Enter your playlist link again");
    expect(screen.textContent).toContain(
      "Your keychain no longer gives Mr. Streamer the saved link from iptv.example.com.",
    );
    expect(screen.textContent).not.toContain("password");
    // One field, for the link, empty and ready to paste into; nothing to go back to without it.
    const fields = [...screen.querySelectorAll("input")];
    expect(fields.map((field) => field.value)).toEqual([""]);
    expect(focused()).toBe("M3U link");
    expect(button(screen, "Cancel")).toBeUndefined();

    await type(screen, ["https://iptv.example.com/list.m3u?token=t0k3n"]);
    ipc.hold("subscription.connect");
    await click(screen, "Connect");

    expect(ipc.argsOf("subscription.connect")).toEqual([
      { server: "https://iptv.example.com/list.m3u?token=t0k3n", username: "", password: "" },
    ]);
  });

  it("asks for a login's password again, with the rest filled in", async () => {
    const screen = await connectScreen(
      locked({
        kind: "xtream",
        id: "https://line.example.tv|demo",
        server: "https://line.example.tv",
        username: "demo",
      }),
    );

    expect(screen.querySelector("h1")?.textContent).toBe("Enter your password again");
    expect(screen.textContent).toContain(
      "Your keychain no longer gives Mr. Streamer the saved password.",
    );
    const fields = [...screen.querySelectorAll("input")];
    expect(fields.map((field) => field.value)).toEqual(["https://line.example.tv", "demo", ""]);
    expect(focused()).toBe("Password");
    expect(button(screen, "Cancel")).toBeUndefined();
  });
});
