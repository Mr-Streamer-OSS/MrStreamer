// The macOS menu bar, in the interface language. Windows and Linux have no app menu.
import type { MenuItemConstructorOptions } from "electron";
import { t } from "@mrstreamer/core/i18n";

/**
 * Electron's default menu, items and shortcuts alike, with the app's labels in the interface
 * language: Edit keeps the shortcuts fields need, such as paste. macOS adds a few items itself,
 * such as Start Dictation, in the system's language. Help opens the website with `openWebsite`.
 */
export function macMenu(name: string, openWebsite: () => void): MenuItemConstructorOptions[] {
  return [
    {
      role: "appMenu",
      label: name,
      submenu: [
        { role: "about", label: t("About {app}", { app: name }) },
        { type: "separator" },
        { role: "services", label: t("Services") },
        { type: "separator" },
        { role: "hide", label: t("Hide {app}", { app: name }) },
        { role: "hideOthers", label: t("Hide Others") },
        { role: "unhide", label: t("Show All") },
        { type: "separator" },
        { role: "quit", label: t("Quit {app}", { app: name }) },
      ],
    },
    {
      role: "fileMenu",
      label: t("File"),
      submenu: [{ role: "close", label: t("Close Window") }],
    },
    {
      role: "editMenu",
      label: t("Edit"),
      submenu: [
        { role: "undo", label: t("Undo") },
        { role: "redo", label: t("Redo") },
        { type: "separator" },
        { role: "cut", label: t("Cut") },
        { role: "copy", label: t("Copy") },
        { role: "paste", label: t("Paste") },
        { role: "pasteAndMatchStyle", label: t("Paste and Match Style") },
        { role: "delete", label: t("Delete") },
        { role: "selectAll", label: t("Select All") },
        { type: "separator" },
        {
          label: t("Speech"),
          submenu: [
            { role: "startSpeaking", label: t("Start Speaking") },
            { role: "stopSpeaking", label: t("Stop Speaking") },
          ],
        },
      ],
    },
    {
      role: "viewMenu",
      label: t("View"),
      submenu: [
        { role: "reload", label: t("Reload") },
        { role: "forceReload", label: t("Force Reload") },
        { role: "toggleDevTools", label: t("Toggle Developer Tools") },
        { type: "separator" },
        { role: "resetZoom", label: t("Actual Size") },
        { role: "zoomIn", label: t("Zoom In") },
        { role: "zoomOut", label: t("Zoom Out") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("Toggle Full Screen") },
      ],
    },
    {
      role: "windowMenu",
      label: t("Window"),
      submenu: [
        { role: "minimize", label: t("Minimize") },
        { role: "zoom", label: t("Zoom") },
        { type: "separator" },
        { role: "front", label: t("Bring All to Front") },
      ],
    },
    {
      role: "help",
      label: t("Help"),
      submenu: [{ label: t("Mr. Streamer website"), click: openWebsite }],
    },
  ];
}
