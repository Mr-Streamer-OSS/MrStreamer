import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { store } from "../src/store.ts";

it("applies callable updaters across realms and prototype chains, notifying with the result", () => {
  const foreign: (current: number) => number = runInNewContext("(current) => current + 1");
  const detached = (current: number) => current + 1;
  Object.setPrototypeOf(detached, null);
  const proxied = new Proxy((current: number) => current + 1, {});
  const value = store(1);
  const seen: number[] = [];
  const unsubscribe = value.subscribe(() => seen.push(value.get()));

  for (const updater of [foreign, detached, proxied]) value.set(updater);
  expect(value.get()).toBe(4);
  expect(seen).toEqual([2, 3, 4]);
  value.set(4);
  expect(seen).toEqual([2, 3, 4]);
  unsubscribe();
  value.set(5);
  expect(value.get()).toBe(5);
  expect(seen).toEqual([2, 3, 4]);
});
