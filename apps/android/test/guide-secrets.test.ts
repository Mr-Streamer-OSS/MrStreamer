import { expect, it, vi } from "vitest";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

import { playlistSecrets, playlistUncertain } from "../src/guide/secrets.ts";

it("decodes valid userinfo escapes alongside a malformed escape", () => {
  expect(playlistSecrets("https://user%oops:p%61ss@fixture.test/list")).toContain("pass");
});

it("does not treat known playlist settings as secrets", () => {
  expect(playlistUncertain("https://fixture.test/list?type=m3u_plus&output=ts&sig=hidden")).toEqual(
    ["hidden"],
  );
});

it("keeps raw ampersands in userinfo secrets", () => {
  expect(playlistSecrets("https://name:&secret@fixture.test/list")).toContain("&secret");
  expect(playlistSecrets("https://name:p&ss@fixture.test/list")).toContain("p&ss");
});
