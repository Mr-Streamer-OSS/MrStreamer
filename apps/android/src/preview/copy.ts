import { catalogue } from "@mrstreamer/mobile/language";

const english = {
  "Explore app": "Explore app",
  "Fictional examples, no login": "Fictional examples, no login",
  "Preview mode": "Preview mode",
  "Fictional examples": "Fictional examples",
  "Add provider": "Add provider",
  "Exit preview": "Exit preview",
  "Keep exploring": "Keep exploring",
  Example: "Example",
  Cast: "Cast",
  "Add a provider to play": "Add a provider to play",
  "Examples have no video. Add your provider to play your own channels and films.":
    "Examples have no video. Add your provider to play your own channels and films.",
  "Add a provider to download": "Add a provider to download",
  "Examples have no video to save. Add your provider to download your own films and episodes.":
    "Examples have no video to save. Add your provider to download your own films and episodes.",
  "Add a provider to cast": "Add a provider to cast",
  "Examples have no video. Add your provider to watch your own channels and films on a TV.":
    "Examples have no video. Add your provider to watch your own channels and films on a TV.",
  "Add a provider to set reminders": "Add a provider to set reminders",
  "Examples aren't saved, so no reminder is set. Add your provider to get reminders for your own guide.":
    "Examples aren't saved, so no reminder is set. Add your provider to get reminders for your own guide.",
  "Add a provider to save": "Add a provider to save",
  "Examples aren't saved. Add your provider to keep your own favourites and watchlist.":
    "Examples aren't saved. Add your provider to keep your own favourites and watchlist.",
};

const dutch = {
  "Explore app": "App verkennen",
  "Fictional examples, no login": "Fictieve voorbeelden, zonder login",
  "Preview mode": "Voorbeeldmodus",
  "Fictional examples": "Fictieve voorbeelden",
  "Add provider": "Provider toevoegen",
  "Exit preview": "Voorbeeld sluiten",
  "Keep exploring": "Verder verkennen",
  Example: "Voorbeeld",
  Cast: "Casten",
  "Add a provider to play": "Voeg een provider toe om af te spelen",
  "Examples have no video. Add your provider to play your own channels and films.":
    "Voorbeelden hebben geen video. Voeg je provider toe om je eigen zenders en films af te spelen.",
  "Add a provider to download": "Voeg een provider toe om te downloaden",
  "Examples have no video to save. Add your provider to download your own films and episodes.":
    "Voorbeelden hebben geen video om te bewaren. Voeg je provider toe om je eigen films en afleveringen te downloaden.",
  "Add a provider to cast": "Voeg een provider toe om te casten",
  "Examples have no video. Add your provider to watch your own channels and films on a TV.":
    "Voorbeelden hebben geen video. Voeg je provider toe om je eigen zenders en films op een tv te kijken.",
  "Add a provider to set reminders": "Voeg een provider toe voor herinneringen",
  "Examples aren't saved, so no reminder is set. Add your provider to get reminders for your own guide.":
    "Voorbeelden worden niet bewaard, dus er komt geen herinnering. Voeg je provider toe voor herinneringen in je eigen gids.",
  "Add a provider to save": "Voeg een provider toe om te bewaren",
  "Examples aren't saved. Add your provider to keep your own favourites and watchlist.":
    "Voorbeelden worden niet bewaard. Voeg je provider toe om je eigen favorieten en kijklijst bij te houden.",
};

/** Preview's own words: its entry, its strip, the Add provider sheet and example labels. */
export const t = catalogue(english, { "nl-NL": dutch });
