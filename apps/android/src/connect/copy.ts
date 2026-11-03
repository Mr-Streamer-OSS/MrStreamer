import { catalogue } from "../live/catalogue.ts";

const english = {
  "Add provider": "Add provider",
  "Server or M3U link": "Server or M3U link",
  Username: "Username",
  Password: "Password",
  Connecting: "Connecting",
  Connect: "Connect",
  Cancel: "Cancel",
  "Connect without encryption (http)": "Connect without encryption (http)",
};

const dutch = {
  "Add provider": "Provider toevoegen",
  "Server or M3U link": "Server of M3U-link",
  Username: "Gebruikersnaam",
  Password: "Wachtwoord",
  Connecting: "Verbinden…",
  Connect: "Verbinden",
  Cancel: "Annuleren",
  "Connect without encryption (http)": "Verbinden zonder versleuteling (http)",
};

export const t = catalogue(english, { "nl-NL": dutch });
