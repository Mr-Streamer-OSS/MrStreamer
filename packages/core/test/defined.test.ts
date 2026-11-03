import { expect, it } from "vitest";
import { defined } from "../src/defined.ts";

it("leaves out undefined fields and keeps every other value, in order", () => {
  const fields = defined({ a: undefined, b: null, c: "", d: 0, e: false, f: "x" });
  expect(Object.keys(fields)).toEqual(["b", "c", "d", "e", "f"]);
  expect(fields).toStrictEqual({ b: null, c: "", d: 0, e: false, f: "x" });
});
