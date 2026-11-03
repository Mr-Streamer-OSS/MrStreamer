import { catalogue } from "@mrstreamer/mobile/language";

const english = {
  "Add provider": "Add provider",
  "Server or M3U link": "Server or M3U link",
  Username: "Username",
  Password: "Password",
  Connecting: "Connecting",
  Connect: "Connect",
  Cancel: "Cancel",
  "Connect without encryption (http)": "Connect without encryption (http)",
  Channels: "Channels",
  "Loading channels": "Loading channels",
  "Couldn't remove this provider.": "Couldn't remove this provider.",
  Remove: "Remove",
  "Its login is erased from this phone.": "Its login is erased from this phone.",
  "Remove {name}?": "Remove {name}?",
  "Try {name} again": "Try {name} again",
  "Remove {name}": "Remove {name}",
  "This phone would not keep the login safe. Nothing was saved.":
    "This phone would not keep the login safe. Nothing was saved.",
  "This phone no longer has its login. Add the provider again to sign in.":
    "This phone no longer has its login. Add the provider again to sign in.",
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
  Channels: "Zenders",
  "Loading channels": "Zenders laden",
  "Couldn't remove this provider.": "Kon deze provider niet verwijderen.",
  Remove: "Verwijderen",
  "Its login is erased from this phone.": "De login wordt van deze telefoon gewist.",
  "Remove {name}?": "{name} verwijderen?",
  "Try {name} again": "{name} opnieuw proberen",
  "Remove {name}": "{name} verwijderen",
  "This phone would not keep the login safe. Nothing was saved.":
    "Deze telefoon kon de login niet veilig bewaren. Er is niets bewaard.",
  "This phone no longer has its login. Add the provider again to sign in.":
    "Deze telefoon heeft de login niet meer. Voeg de provider opnieuw toe om in te loggen.",
};

export const t = catalogue(english, { "nl-NL": dutch });
