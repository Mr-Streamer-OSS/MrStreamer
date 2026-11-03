import { catalogue } from "@mrstreamer/mobile/language";

// Downloads' own messages. Wherever iOS says the same thing, the text and its Dutch follow
// apps/ios/src/i18n/downloads.ts.
const english = {
  "This provider returned a playlist, not a downloadable file.":
    "This provider returned a playlist, not a downloadable file.",
  "This provider returned a document, not a video file.":
    "This provider returned a document, not a video file.",
  "The provider did not report the file size. This file cannot be checked for completion.":
    "The provider did not report the file size. This file cannot be checked for completion.",
  "The file could not be removed. Try removing it again.":
    "The file could not be removed. Try removing it again.",
  Downloads: "Downloads",
  Downloaded: "Downloaded",
  Downloading: "Downloading",
  Queue: "Queue",
  "On this device": "On this device",
  "{size} on this device": "{size} on this device",
  "{size} free": "{size} free",
  "Downloads go on in the background with a notification. After a force stop they wait until you open the app.":
    "Downloads go on in the background with a notification. After a force stop they wait until you open the app.",
  "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.":
    "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.",
  "Nothing downloaded yet.": "Nothing downloaded yet.",
  "Download a movie or an episode from its details.":
    "Download a movie or an episode from its details.",
  "Checking downloads…": "Checking downloads…",
  "Couldn't read downloads.": "Couldn't read downloads.",
  "Couldn't save that change.": "Couldn't save that change.",
  "Try again": "Try again",
  "Provider removed, copy kept": "Provider removed, copy kept",
  // How a download stands.
  Queued: "Queued",
  Paused: "Paused",
  Starting: "Starting",
  Removing: "Removing",
  "started again": "started again",
  "{received} of {size}": "{received} of {size}",
  "Waiting while {source} plays": "Waiting while {source} plays",
  "File missing": "File missing",
  "Disk full. Free some space, then retry.": "Disk full. Free some space, then retry.",
  "The provider login changed or is unavailable.": "The provider login changed or is unavailable.",
  "The download couldn't go on from where it stopped.":
    "The download couldn't go on from where it stopped.",
  // What can be done, and why it couldn't.
  Pause: "Pause",
  Resume: "Resume",
  "Move up": "Move up",
  "Move down": "Move down",
  "Cancel download": "Cancel download",
  Retry: "Retry",
  Remove: "Remove",
  "Play offline": "Play offline",
  "Delete download": "Delete download",
  Delete: "Delete",
  Cancel: "Cancel",
  OK: "OK",
  "Keep downloading": "Keep downloading",
  "Cancel downloading {name}?": "Cancel downloading {name}?",
  "Delete the {size} copy of {name}?": "Delete the {size} copy of {name}?",
  "Delete the copy of {name}?": "Delete the copy of {name}?",
  "Couldn't remove {name}": "Couldn't remove {name}",
  "Stop playing this copy first.": "Stop playing this copy first.",
  "The old copy is still closing. Try again.": "The old copy is still closing. Try again.",
  "Couldn't play {name}": "Couldn't play {name}",
  "The copy on this device can't be read. Delete it and download it again.":
    "The copy on this device can't be read. Delete it and download it again.",
} as const;

const dutch = {
  "This provider returned a playlist, not a downloadable file.":
    "Deze provider gaf een afspeellijst terug, geen downloadbaar bestand.",
  "This provider returned a document, not a video file.":
    "Deze provider gaf een document terug, geen videobestand.",
  "The provider did not report the file size. This file cannot be checked for completion.":
    "De provider gaf geen bestandsgrootte door. Deze download kan niet op volledigheid worden gecontroleerd.",
  "The file could not be removed. Try removing it again.":
    "Het bestand kon niet worden verwijderd. Probeer het opnieuw.",
  Downloads: "Downloads",
  Downloaded: "Gedownload",
  Downloading: "Downloaden",
  Queue: "Wachtrij",
  "On this device": "Op dit apparaat",
  "{size} on this device": "{size} op dit apparaat",
  "{size} free": "{size} vrij",
  "Downloads go on in the background with a notification. After a force stop they wait until you open the app.":
    "Downloads gaan op de achtergrond verder met een melding. Na gedwongen stoppen wachten ze tot je de app opent.",
  "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.":
    "Downloads gaan op de achtergrond verder. Meldingen staan uit. Na gedwongen stoppen wachten ze tot je de app opent.",
  "Nothing downloaded yet.": "Nog niets gedownload.",
  "Download a movie or an episode from its details.":
    "Download een film of aflevering vanuit de details.",
  "Checking downloads…": "Downloads controleren…",
  "Couldn't read downloads.": "Downloads konden niet worden gelezen.",
  "Couldn't save that change.": "Die wijziging kon niet worden opgeslagen.",
  "Try again": "Opnieuw proberen",
  "Provider removed, copy kept": "Provider verwijderd, kopie bewaard",
  Queued: "In de wachtrij",
  Paused: "Gepauzeerd",
  Starting: "Starten",
  Removing: "Wordt verwijderd",
  "started again": "opnieuw begonnen",
  "{received} of {size}": "{received} van {size}",
  "Waiting while {source} plays": "Wacht terwijl {source} speelt",
  "File missing": "Bestand ontbreekt",
  "Disk full. Free some space, then retry.": "Schijf vol. Maak ruimte vrij en probeer het opnieuw.",
  "The provider login changed or is unavailable.":
    "De login van de provider is gewijzigd of niet beschikbaar.",
  "The download couldn't go on from where it stopped.":
    "De download kon niet verder waar hij was gestopt.",
  Pause: "Pauzeren",
  Resume: "Hervatten",
  "Move up": "Omhoog",
  "Move down": "Omlaag",
  "Cancel download": "Download annuleren",
  Retry: "Opnieuw",
  Remove: "Verwijderen",
  "Play offline": "Offline afspelen",
  "Delete download": "Download verwijderen",
  Delete: "Verwijderen",
  Cancel: "Annuleren",
  OK: "OK",
  "Keep downloading": "Doorgaan met downloaden",
  "Cancel downloading {name}?": "Downloaden van {name} annuleren?",
  "Delete the {size} copy of {name}?": "De kopie van {size} van {name} verwijderen?",
  "Delete the copy of {name}?": "De kopie van {name} verwijderen?",
  "Couldn't remove {name}": "{name} kon niet worden verwijderd",
  "Stop playing this copy first.": "Stop eerst met het afspelen van deze kopie.",
  "The old copy is still closing. Try again.":
    "De oude kopie wordt nog gesloten. Probeer het opnieuw.",
  "Couldn't play {name}": "{name} kon niet worden afgespeeld",
  "The copy on this device can't be read. Delete it and download it again.":
    "De kopie op dit apparaat kan niet worden gelezen. Verwijder hem en download hem opnieuw.",
} as const;

export const t = catalogue(english, { "nl-NL": dutch });
