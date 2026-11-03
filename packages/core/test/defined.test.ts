import { describe, expect, it } from "vitest";
import { defined } from "../src/defined.ts";

describe("defined", () => {
  it("leaves out undefined fields and keeps every other value, in order", () => {
    const fields = defined({ a: undefined, b: null, c: "", d: 0, e: false, f: "x" });
    expect(Object.keys(fields)).toEqual(["b", "c", "d", "e", "f"]);
    expect(fields).toStrictEqual({ b: null, c: "", d: 0, e: false, f: "x" });
  });

  it("spreads into an object without adding the missing keys", () => {
    const logo: string | undefined = undefined;
    const built = { id: "1", ...defined({ logo }) };
    expect("logo" in built).toBe(false);
  });
});
