// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { act, createElement, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { queryView } from "./mount.ts";
import { QueryClient } from "@tanstack/react-query";
import { Grid } from "../../src/renderer/src/features/titles/CollectionGrid.tsx";
import { useKeptScroll } from "../../src/renderer/src/lib/use-kept-scroll.ts";

let unmount = () => {};
let restoreScroll = () => {};

afterEach(() => {
  unmount();
  restoreScroll();
  vi.unstubAllGlobals();
});

async function list() {
  let ready = false;
  ipc.reset();
  let saved = -1;
  let height = 0;
  let position = 0;

  function List() {
    const ref = useRef<HTMLDivElement>(null);
    useKeptScroll(
      ref,
      {
        from: 700,
        keep: (top) => {
          saved = top;
        },
      },
      ready,
    );

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
    async complete() {
      ready = true;
      await mounted.render(createElement(List));
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
  await page.complete();
  expect(page.position()).toBe(50);
  await act(async () => {
    page.element.scrollTop = 10;
    page.element.append(document.createElement("div"));
  });
  expect(page.position()).toBe(10);
  await page.leave();
});

it("waits for all content after an initially overflowing section", async () => {
  const page = await list();
  page.grow(50);
  Object.defineProperties(page.element, {
    scrollHeight: { value: 150 },
    clientHeight: { value: 100 },
  });
  await act(async () => {
    page.element.append(document.createElement("div"));
  });
  page.grow(1000);
  await page.complete();
  expect(page.position()).toBe(700);
  await page.leave();
});

it("waits for the poster grid width before restoring a deep offset", async () => {
  ipc.reset();
  let width = 0;
  let position = 0;
  const notify: (() => void)[] = [];
  const OriginalObserver = ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class extends OriginalObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        notify.push(() => callback([], this));
      }
    },
  );
  const descriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = Math.min(value, width > 0 ? 1000 : 50);
      },
    },
    scrollHeight: { configurable: true, get: () => (width > 0 ? 1100 : 150) },
    clientHeight: { configurable: true, get: () => 100 },
  });
  restoreScroll = () => {
    for (const property of ["clientWidth", "scrollTop", "scrollHeight", "clientHeight"]) {
      const descriptor = descriptors[property];

      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, property);
    }
  };

  const mounted = queryView(new QueryClient());
  unmount = mounted.unmount;
  await mounted.render(
    createElement(Grid<string>, {
      total: 500,
      itemAt: (index) => String(index),
      keyOf: (item) => item,
      onVisible: () => {},
      active: false,
      onOpen: () => {},
      tile: (item) => createElement("button", null, item),
      kept: { from: { top: 700, index: 499, key: "499" }, keep: () => {} },
    }),
  );
  await act(async () => {
    width = 960;

    for (const update of notify) update();
  });
  expect(position).toBe(700);
});
