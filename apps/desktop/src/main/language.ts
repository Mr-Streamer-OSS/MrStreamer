// The interface language in the main process: what Settings saved, resolved against the
// system's languages, and shown in main's own text, its dialogs and the macOS menu bar. The
// window asks for it before its first paint and is told the new one when Settings changes it,
// so neither waits for a restart.
import { app, Menu, shell } from "electron";
import type { InterfaceLanguage } from "@mrstreamer/contracts/language";
import { resolveLanguage, setLanguage } from "@mrstreamer/core/i18n";
import { macMenu } from "./menu.ts";

const WEBSITE = "https://mrstreamer.app";

/** The language for what Settings saved, with the system's languages as they are now. */
export function languageFor(saved: string | undefined): InterfaceLanguage {
  return resolveLanguage(saved, app.getPreferredSystemLanguages());
}

/** Shows main's text, and on macOS the menu bar, in `language`. */
export function applyLanguage(language: InterfaceLanguage): void {
  setLanguage(language);
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(macMenu(app.name, () => void shell.openExternal(WEBSITE))),
    );
  }
}
