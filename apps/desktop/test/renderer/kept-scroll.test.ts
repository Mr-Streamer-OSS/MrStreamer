// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { act, createElement, useRef } from "react";
import { afterEach, expect, it } from "vitest";
import { queryView } from "./mount.ts";
import { QueryClient } from "@tanstack/react-query";
import { useKeptScroll } from "../../src/renderer/src/lib/use-kept-scroll.ts";

let unmount = () => {};
let restoreScroll = () => {};

afterEach(() => {
  unmount();
  restoreScroll();
});

async function list() {
  ipc.reset();
  let saved = -1;
  let height = 0;
  let position = 0;

  function List() {
    const ref = useRef<HTMLDivElement>(null);
    useKeptScroll(ref, {
      from: 700,
      keep: (top) => {
        saved = top;
      },
    });

    return createElement("div", { ref, role: "list" });
  }

  const mounted = queryView(new QueryClient());
  unmount = mounted.unmount;
  // Clamp like a browser before any rows have arrived.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  restoreScroll = () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", descriptor);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
  };

  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = Math.min(value, height);
    },
  });
  await mounted.render(createElement(List));
  const element = mounted.container.querySelector<HTMLElement>('[role="list"]')!;

  return {
    element,
    saved: () => saved,
    position: () => position,
    grow: (value: number) => {
      height = value;
    },
    async leave() {
      await mounted.render(null);
      restoreScroll();
    },
  };
}

it("keeps the pending offset when leaving before rows arrive", async () => {
  const page = await list();
  await page.leave();
  expect(page.saved()).toBe(700);
});

it("lets a window keyboard move cancel restoration after the list shrinks", async () => {
  const page = await list();
  page.grow(50);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    page.element.scrollTop = 10;
    page.element.append(document.createElement("div"));
  });
  expect(page.position()).toBe(10);
  await page.leave();
});

it("finishes restoration at a measured shorter extent", async () => {
  const page = await list();
  page.grow(50);
  Object.defineProperties(page.element, {
    scrollHeight: { value: 150 },
    clientHeight: { value: 100 },
  });
  await act(async () => {
    page.element.append(document.createElement("div"));
  });
  expect(page.position()).toBe(50);
  await act(async () => {
    page.element.scrollTop = 10;
    page.element.append(document.createElement("div"));
  });
  expect(page.position()).toBe(10);
  await page.leave();
});
