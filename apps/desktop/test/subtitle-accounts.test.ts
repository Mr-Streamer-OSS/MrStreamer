import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { SubtitleAccounts } from "../src/main/services/subtitle-accounts.ts";
import { promised, runtimeFor, tempDir, testSecrets } from "./support.ts";

const preferences = { enabled: false, languages: ["en", "nl"], service: "both" as const };
const keys = {
  subdl: { apiKey: "private-subdl-key" },
  opensubtitles: {
    apiKey: "private-open-key",
    username: "private-name",
    password: "private-password",
  },
};

describe("online subtitle account settings", () => {
  it("does not echo rejected credential contents in a failure", async () => {
    const accounts = await promised(
      runtimeFor(SubtitleAccounts.layer(await tempDir(), testSecrets)),
      SubtitleAccounts,
    );
    const secret = "private-key".repeat(1000);
    await expect(accounts.update(preferences, { subdl: { apiKey: secret } })).rejects.toMatchObject(
      {
        error: {
          kind: "unexpected",
          detail: "Subtitle account details couldn't be read or saved.",
        },
      },
    );
    expect((await accounts.get()).configured.subdl).toBe(false);
  });
  it("starts disabled, seals both services and reads settings after restart without opening secrets", async () => {
    const dir = await tempDir();
    const secrets = { seal: vi.fn(testSecrets.seal), open: vi.fn(testSecrets.open) };
    const start = () => runtimeFor(SubtitleAccounts.layer(dir, secrets));
    const first = start();
    const accounts = await promised(first, SubtitleAccounts);
    expect(await accounts.get()).toEqual({
      enabled: false,
      languages: ["en"],
      service: "both",
      configured: { subdl: false, opensubtitles: false },
    });
    expect(await accounts.update(preferences, keys)).toEqual({
      ...preferences,
      configured: { subdl: true, opensubtitles: true },
    });
    expect(secrets.open).not.toHaveBeenCalled();
    const stored = await readFile(join(dir, "subtitle-accounts.json"), "utf8");
    for (const secret of [keys.subdl.apiKey, ...Object.values(keys.opensubtitles)])
      expect(stored).not.toContain(secret);
    await first.dispose();
    const second = await promised(start(), SubtitleAccounts);
    expect((await second.get()).enabled).toBe(false);
    expect(secrets.open).not.toHaveBeenCalled();
    expect(await second.credentials("subdl")).toEqual(keys.subdl);
    expect(await second.credentials("opensubtitles")).toEqual(keys.opensubtitles);
  });

  it("updates one service independently and leaves saved settings intact when the keychain refuses", async () => {
    const dir = await tempDir();
    const accounts = await promised(
      runtimeFor(SubtitleAccounts.layer(dir, testSecrets)),
      SubtitleAccounts,
    );
    await accounts.update(preferences, keys);
    await accounts.update({ ...preferences, enabled: true }, { subdl: null });
    expect(await accounts.get()).toEqual({
      ...preferences,
      enabled: true,
      configured: { subdl: false, opensubtitles: true },
    });
    expect(await accounts.credentials("subdl")).toBeNull();
    expect(await accounts.credentials("opensubtitles")).toEqual(keys.opensubtitles);

    const refused = await promised(
      runtimeFor(
        SubtitleAccounts.layer(dir, {
          seal: () => {
            throw new AppFailure({ kind: "keychain-refused" });
          },
          open: () => {
            throw new AppFailure({ kind: "keychain-refused" });
          },
        }),
      ),
      SubtitleAccounts,
    );
    // Displaying or changing non-secret settings does not prompt the keychain.
    await refused.update({ ...preferences, enabled: false });
    await expect(
      refused.update({ ...preferences, enabled: true }, { subdl: keys.subdl }),
    ).rejects.toMatchObject({ error: { kind: "keychain-refused" } });
    expect(await refused.get()).toEqual({
      ...preferences,
      configured: { subdl: false, opensubtitles: true },
    });
    await expect(refused.credentials("opensubtitles")).rejects.toMatchObject({
      error: { kind: "keychain-refused" },
    });
  });
});
