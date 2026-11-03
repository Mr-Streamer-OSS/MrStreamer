import { describe, expect, it } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";
import { catalogue } from "../language/catalogue.ts";
import { resolveAndroidLanguage } from "../language/resolve.ts";

describe("Android language", () => {
  it("restricts system and saved languages to Android's two locales", () => {
    expect(resolveAndroidLanguage("system", ["de-DE", "nl-BE"]).locale).toBe("nl-NL");
    expect(resolveAndroidLanguage("system", ["fr-FR"]).locale).toBe("en-US");
    expect(resolveAndroidLanguage("fr-FR", ["nl-NL"]).locale).toBe("en-US");
  });
  it("renders a feature's complete Dutch catalogue and placeholders", () => {
    const t = catalogue({ "Hi {name}": "Hi {name}" }, { "nl-NL": { "Hi {name}": "Hoi {name}" } });
    setLanguage({ locale: "nl-NL", formats: "nl-BE" });

    try {
      expect(t("Hi {name}", { name: "Wout" })).toBe("Hoi Wout");
    } finally {
      setLanguage({ locale: "en-US", formats: "en-US" });
    }

    // @ts-expect-error A missing Dutch key must fail compilation.
    catalogue({ Hello: "Hello" }, { "nl-NL": {} });
  });
});
