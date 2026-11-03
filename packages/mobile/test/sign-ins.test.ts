import { describe, expect, it } from "vitest";
import { signIns, type SignIns } from "../accounts/sign-ins.ts";

// The sign-ins both mobile apps keep: which login a source answers with, and which list loads
// still count. Each app's own suite proves the outcomes through its screens' state; these hold the
// contract both rely on.

type Login = { readonly name: string };
const login = (name: string): Login => ({ name });

describe("sign-ins", () => {
  it("counts only the latest load of a list, leaving the source's other lists alone", () => {
    const sources = signIns<Login>();
    sources.set("a", login("one"));
    const first = sources.begin("a", "live");
    const titles = sources.begin("a", "titles");
    const second = sources.begin("a", "live");

    expect([first?.stands(), first?.signal.aborted]).toEqual([false, true]);
    expect([second?.stands(), titles?.stands()]).toEqual([true, true]);
  });

  it.each([
    ["signed in again", (sources: SignIns<Login>) => sources.set("a", login("two"))],
    ["signed out", (sources: SignIns<Login>) => sources.drop("a")],
  ])("ends every load of a source %s, and only that source's", (_, change) => {
    const sources = signIns<Login>();
    sources.set("a", login("one"));
    sources.set("b", login("other"));
    const loads = [sources.begin("a", "live"), sources.begin("a", "titles")];
    const other = sources.begin("b", "live");
    let told = 0;
    sources.onChange(() => told++);

    change(sources);

    expect(loads.map((load) => [load?.stands(), load?.signal.aborted])).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(other?.stands()).toBe(true);
    expect([sources.replaced(), told]).toEqual([1, 1]);
  });

  it("begins nothing for a source signed out, and asks for its secret", () => {
    const sources = signIns<Login>();
    sources.set("a", login("one"));
    sources.drop("a");
    sources.drop("a");

    expect(sources.begin("a", "live")).toBeNull();
    expect(sources.all()).toEqual([]);
    expect(sources.replaced()).toBe(1);
    expect(() => sources.of("a")).toThrow(
      expect.objectContaining({ error: { kind: "needs-secret", subscriptionId: "a" } }),
    );
  });
});
