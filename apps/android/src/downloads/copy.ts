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
  "File changed. Replace it to play.": "File changed. Replace it to play.",
  "File changed": "File changed",
  Replace: "Replace",
  "Replace the copy of {name}?": "Replace the copy of {name}?",
  "Its file changed on this device. Replacing deletes it and downloads {episode} again in the same version.":
    "Its file changed on this device. Replacing deletes it and downloads {episode} again in the same version.",
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
  // A series' bulk downloads, in iOS's words (apps/ios/src/i18n/downloads.ts).
  "{count} episodes": { one: "{count} episode", other: "{count} episodes" },
  "Whole series": "Whole series",
  "{held} of {total} saved or queued": "{held} of {total} saved or queued",
  "Adding {done} of {total}": "Adding {done} of {total}",
  "Stops if you leave this series": "Stops if you leave this series",
  "Download remaining": "Download remaining",
  "Review series download": "Review series download",
  "Cancel remaining": "Cancel remaining",
  "Download {name}?": "Download {name}?",
  "Download all of {name}?": "Download all of {name}?",
  "Download {episodes}": "Download {episodes}",
  "Download {remaining} and replace {count} missing": {
    one: "Download {remaining} and replace {count} missing",
    other: "Download {remaining} and replace {count} missing",
  },
  "Replace {count} missing files": {
    one: "Replace {count} missing file",
    other: "Replace {count} missing files",
  },
  "{episodes} in {seasons} seasons.": "{episodes} in {seasons} seasons.",
  "{count} already saved or queued.": {
    one: "{count} already saved or queued.",
    other: "{count} already saved or queued.",
  },
  "{count} failed and will be retried.": {
    one: "{count} failed and will be retried.",
    other: "{count} failed and will be retried.",
  },
  "{count} saved files are missing.": {
    one: "{count} saved file is missing.",
    other: "{count} saved files are missing.",
  },
  // Android only: a changed file is replaced from its own row, which asks first.
  "{count} saved files changed. Replace them in Downloads.": {
    one: "{count} saved file changed. Replace it in Downloads.",
    other: "{count} saved files changed. Replace them in Downloads.",
  },
  "Size unavailable.": "Size unavailable.",
  "Uses the selected version.": "Uses the selected version.",
  "All {count} episodes are saved or queued.": {
    one: "{count} episode is saved or queued.",
    other: "All {count} episodes are saved or queued.",
  },
  "{count} queued.": { one: "{count} queued.", other: "{count} queued." },
  "{count} retried.": { one: "{count} retried.", other: "{count} retried." },
  "{count} replaced.": { one: "{count} replaced.", other: "{count} replaced." },
  "{count} changed meanwhile and stayed as they were.": {
    one: "{count} changed meanwhile and stayed as they were.",
    other: "{count} changed meanwhile and stayed as they were.",
  },
  // Android's admission reports no reason for a failed episode.
  "{count} failed.": { one: "{count} failed.", other: "{count} failed." },
  "Cancelled before {episodes}.": "Cancelled before {episodes}.",
  "Stopped before {episodes}: the provider signed in anew or was removed.":
    "Stopped before {episodes}: the provider signed in anew or was removed.",
  "Stopped before {episodes}: a version was chosen meanwhile.":
    "Stopped before {episodes}: a version was chosen meanwhile.",
  "Nothing was added.": "Nothing was added.",
  "Couldn't download {name}": "Couldn't download {name}",
  "Episodes of another download are still being added.":
    "Episodes of another download are still being added.",
  "The version or its provider changed. Try again.":
    "The version or its provider changed. Try again.",
  "Retry failed": "Retry failed",
  "Open Downloads": "Open Downloads",
  // Offline Next at the end of a downloaded episode.
  "{episode} isn't on this device": "{episode} isn't on this device",
  "{episode} download is paused": "{episode} download is paused",
  "{episode} is still downloading": "{episode} is still downloading",
  "The next episode": "The next episode",
  "Download it to go on.": "Download it to go on.",
  "Replace it to go on.": "Replace it to go on.",
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
  "File changed. Replace it to play.": "Bestand veranderd. Vervang het om af te spelen.",
  "File changed": "Bestand veranderd",
  Replace: "Vervangen",
  "Replace the copy of {name}?": "De kopie van {name} vervangen?",
  "Its file changed on this device. Replacing deletes it and downloads {episode} again in the same version.":
    "Het bestand is op dit apparaat veranderd. Vervangen verwijdert het en downloadt {episode} opnieuw in dezelfde versie.",
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
  "{count} episodes": { one: "{count} aflevering", other: "{count} afleveringen" },
  "Whole series": "Hele serie",
  "{held} of {total} saved or queued": "{held} van {total} bewaard of in de wachtrij",
  "Adding {done} of {total}": "{done} van {total} toevoegen",
  "Stops if you leave this series": "Stopt als je deze serie verlaat",
  "Download remaining": "Rest downloaden",
  "Review series download": "Serie downloaden bekijken",
  "Cancel remaining": "De rest annuleren",
  "Download {name}?": "{name} downloaden?",
  "Download all of {name}?": "Alles van {name} downloaden?",
  "Download {episodes}": "{episodes} downloaden",
  "Download {remaining} and replace {count} missing": {
    one: "{remaining} downloaden en {count} ontbrekende vervangen",
    other: "{remaining} downloaden en {count} ontbrekende vervangen",
  },
  "Replace {count} missing files": {
    one: "{count} ontbrekend bestand vervangen",
    other: "{count} ontbrekende bestanden vervangen",
  },
  "{episodes} in {seasons} seasons.": "{episodes} in {seasons} seizoenen.",
  "{count} already saved or queued.": {
    one: "{count} al bewaard of in de wachtrij.",
    other: "{count} al bewaard of in de wachtrij.",
  },
  "{count} failed and will be retried.": {
    one: "{count} mislukt en wordt opnieuw geprobeerd.",
    other: "{count} mislukt en worden opnieuw geprobeerd.",
  },
  "{count} saved files are missing.": {
    one: "{count} bewaard bestand ontbreekt.",
    other: "{count} bewaarde bestanden ontbreken.",
  },
  "{count} saved files changed. Replace them in Downloads.": {
    one: "{count} bewaard bestand is veranderd. Vervang het in Downloads.",
    other: "{count} bewaarde bestanden zijn veranderd. Vervang ze in Downloads.",
  },
  "Size unavailable.": "Grootte onbekend.",
  "Uses the selected version.": "Gebruikt de gekozen versie.",
  "All {count} episodes are saved or queued.": {
    one: "{count} aflevering is bewaard of in de wachtrij.",
    other: "Alle {count} afleveringen zijn bewaard of in de wachtrij.",
  },
  "{count} queued.": {
    one: "{count} in de wachtrij gezet.",
    other: "{count} in de wachtrij gezet.",
  },
  "{count} retried.": {
    one: "{count} opnieuw geprobeerd.",
    other: "{count} opnieuw geprobeerd.",
  },
  "{count} replaced.": { one: "{count} vervangen.", other: "{count} vervangen." },
  "{count} changed meanwhile and stayed as they were.": {
    one: "{count} is intussen veranderd en bleef zoals hij was.",
    other: "{count} zijn intussen veranderd en bleven zoals ze waren.",
  },
  "{count} failed.": { one: "{count} mislukt.", other: "{count} mislukt." },
  "Cancelled before {episodes}.": "Geannuleerd vóór {episodes}.",
  "Stopped before {episodes}: the provider signed in anew or was removed.":
    "Gestopt vóór {episodes}: de provider is opnieuw ingelogd of verwijderd.",
  "Stopped before {episodes}: a version was chosen meanwhile.":
    "Gestopt vóór {episodes}: intussen is een versie gekozen.",
  "Nothing was added.": "Er is niets toegevoegd.",
  "Couldn't download {name}": "{name} kon niet worden gedownload",
  "Episodes of another download are still being added.":
    "Afleveringen van een andere download worden nog toegevoegd.",
  "The version or its provider changed. Try again.":
    "De versie of de provider is veranderd. Probeer het opnieuw.",
  "Retry failed": "Mislukte opnieuw proberen",
  "Open Downloads": "Downloads openen",
  "{episode} isn't on this device": "{episode} staat niet op dit apparaat",
  "{episode} download is paused": "Download van {episode} is gepauzeerd",
  "{episode} is still downloading": "{episode} wordt nog gedownload",
  "The next episode": "De volgende aflevering",
  "Download it to go on.": "Download hem om verder te kijken.",
  "Replace it to go on.": "Vervang hem om verder te kijken.",
} as const;

export const t = catalogue(english, { "nl-NL": dutch });
