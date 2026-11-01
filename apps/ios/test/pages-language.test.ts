import { createRoot, document, type Root } from "./dom.ts";
import { setLanguage } from "@mrstreamer/core/i18n";
import type { Locale } from "@mrstreamer/contracts/language";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";

// Settings' own pages in the interface language: Diagnostics' title, Share and note follow it while
// the text it shares stays as written, and a licence's labels follow it while its names, versions
// and paths stay as the build gives them. A new language redraws the open page where it stands.
// The real screens render with React DOM on a happy-dom window over React Native stand-ins.

const scenario = vi.hoisted(() => ({
  /** The options a screen set on its top bar, newest last. */
  options: [] as Record<string, unknown>[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => (await import("./react-native.ts")).reactNative);
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "fflate@0.8.2" }),
  useNavigation: () => ({
    setOptions: (options: Record<string, unknown>) => scenario.options.push(options),
  }),
}));
vi.mock("../src/open-link.ts", () => ({ openLink: () => undefined }));
const REPORT = "Mr. Streamer 0.2.0 (12)\nProviders: 1";
vi.mock("../src/diagnostics.ts", () => ({ diagnosticsText: () => REPORT }));
vi.mock("../src/licences.ts", () => ({
  licenceOf: () => ({
    id: "fflate@0.8.2",
    name: "fflate",
    licence: "MIT",
    source: "https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz",
    facts: [
      { label: "Version", value: "0.8.2" },
      { label: "In the app", value: "JavaScript" },
      { label: "Changed by", value: "apps/ios/patches/fflate.patch" },
    ],
    notices: [],
  }),
  noticeText: () => "",
}));

const { default: Diagnostics } = await import("../src/app/(tabs)/(home)/diagnostics.tsx");
const { default: Licence } = await import("../src/app/(tabs)/(home)/licence.tsx");

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function open(node: React.ReactNode) {
  container = document.createElement("div");
  root = createRoot(container);
  React.act(() => root!.render(node));
}
const speak = (locale: Locale) => React.act(() => setLanguage({ locale, formats: locale }));
const latest = () => scenario.options.at(-1)!;
const share = () => {
  const items = latest()["unstable_headerRightItems"] as () => { label: string }[];
  return items()[0]!.label;
};

afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
  scenario.options.length = 0;
  setLanguage({ locale: "en-US", formats: "en-US" });
});

it("words Diagnostics in the language and shares its text as written", () => {
  speak("de-DE");
  open(React.createElement(Diagnostics));
  expect(latest()["title"]).toBe("Diagnose");
  expect(share()).toBe("Teilen");
  expect(container.textContent).toContain("Wird genau so geteilt wie unten.");
  expect(container.textContent).toContain(REPORT);

  speak("fr-FR");
  expect(latest()["title"]).toBe("Diagnostic");
  expect(share()).toBe("Partager");
  expect(container.textContent).toContain("Partagé exactement comme ci-dessous.");
  expect(container.textContent).toContain(REPORT);
});

it("labels a licence in the language and keeps its names, versions and paths", () => {
  speak("es-ES");
  open(React.createElement(Licence));
  const facts = () =>
    [...container.querySelectorAll("[aria-label]")].map((each) => each.getAttribute("aria-label"));
  expect(facts()).toEqual([
    "Licencia, MIT",
    "Versión, 0.8.2",
    "En la app, JavaScript",
    "Modificado por, apps/ios/patches/fflate.patch",
    "Código fuente",
  ]);

  speak("nl-NL");
  expect(facts()).toEqual([
    "Licentie, MIT",
    "Versie, 0.8.2",
    "In de app, JavaScript",
    "Aangepast door, apps/ios/patches/fflate.patch",
    "Broncode",
  ]);
});
