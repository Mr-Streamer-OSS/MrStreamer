import { catalogue } from "../library/catalogue.ts";

const english = {
  "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.":
    "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.",
  Downloaded: "Downloaded",
  Downloads: "Downloads",
  Queue: "Queue",
  "On this device": "On this device",
  Pause: "Pause",
  Resume: "Resume",
  Retry: "Retry",
  Remove: "Remove",
  "Delete download": "Delete download",
  "Cancel download": "Cancel download",
  "Play offline": "Play offline",
  OK: "OK",
  Cancel: "Cancel",
  "Move up": "Move up",
  "Move down": "Move down",
  Queued: "Queued",
  Paused: "Paused",
  Downloading: "Downloading",
  "Checking downloads…": "Checking downloads…",
  "Could not read downloads. Try again.": "Could not read downloads. Try again.",
  "Could not save this change. Try again.": "Could not save this change. Try again.",
  "Not enough free space.": "Not enough free space.",
  "The file is missing.": "The file is missing.",
  "Download interrupted.": "Download interrupted.",
  "Started again because the provider’s file changed.":
    "Started again because the provider’s file changed.",
  "Continued after reopening.": "Continued after reopening.",
  "Stop playing this copy first.": "Stop playing this copy first.",
  "The old copy is still closing. Try again.": "The old copy is still closing. Try again.",
  "This copy can’t be read.": "This copy can’t be read.",
  "Downloads go on in the background with a notification. After a force stop they wait until you open the app.":
    "Downloads go on in the background with a notification. After a force stop they wait until you open the app.",
  "Waiting while {source} plays": "Waiting while {source} plays",
  "{used} used · {free} free": "{used} used · {free} free",
  "Remove this download?": "Remove this download?",
  "The provider login changed or is unavailable.": "The provider login changed or is unavailable.",
  "Nothing downloaded yet.": "Nothing downloaded yet.",
} as const;

const dutch = {
  "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.":
    "Downloads gaan op de achtergrond verder. Meldingen staan uit. Na gedwongen stoppen wachten ze tot je de app opent.",
  Downloaded: "Gedownload",
  Downloads: "Downloads",
  Queue: "Wachtrij",
  "On this device": "Op dit apparaat",
  Pause: "Pauzeren",
  Resume: "Hervatten",
  Retry: "Opnieuw",
  Remove: "Verwijderen",
  "Delete download": "Download verwijderen",
  "Cancel download": "Download annuleren",
  "Play offline": "Offline afspelen",
  OK: "OK",
  Cancel: "Annuleren",
  "Move up": "Omhoog",
  "Move down": "Omlaag",
  Queued: "In de wachtrij",
  Paused: "Gepauzeerd",
  Downloading: "Downloaden",
  "Checking downloads…": "Downloads controleren…",
  "Could not read downloads. Try again.": "Downloads konden niet worden gelezen. Probeer opnieuw.",
  "Could not save this change. Try again.":
    "Deze wijziging kon niet worden opgeslagen. Probeer opnieuw.",
  "Not enough free space.": "Niet genoeg vrije ruimte.",
  "The file is missing.": "Het bestand ontbreekt.",
  "Download interrupted.": "Download onderbroken.",
  "Started again because the provider’s file changed.":
    "Opnieuw begonnen omdat het bestand bij de aanbieder is gewijzigd.",
  "Continued after reopening.": "Hervat na opnieuw openen.",
  "Stop playing this copy first.": "Stop eerst het afspelen van deze kopie.",
  "The old copy is still closing. Try again.":
    "De vorige kopie wordt nog gesloten. Probeer opnieuw.",
  "This copy can’t be read.": "Deze kopie kan niet worden gelezen.",
  "Downloads go on in the background with a notification. After a force stop they wait until you open the app.":
    "Downloads gaan op de achtergrond verder met een melding. Na gedwongen stoppen wachten ze tot je de app opent.",
  "Waiting while {source} plays": "Wacht terwijl {source} afspeelt",
  "{used} used · {free} free": "{used} gebruikt · {free} vrij",
  "Remove this download?": "Deze download verwijderen?",
  "The provider login changed or is unavailable.":
    "De login van de aanbieder is gewijzigd of ontbreekt.",
  "Nothing downloaded yet.": "Nog niets gedownload.",
} as const;

export const t = catalogue(english, { "nl-NL": dutch });
