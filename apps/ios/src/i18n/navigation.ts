import { catalogue } from "./catalogue.ts";

/** The tab bar, its keyboard shortcuts and the shared top bar's buttons (header.tsx). */
export const t = catalogue(
  {
    Home: "Home",
    Live: "Live",
    Movies: "Movies",
    Series: "Series",
    Search: "Search",
    Downloads: "Downloads",
    Settings: "Settings",
    Back: "Back",
  },
  {
    "nl-NL": {
      Home: "Start",
      Live: "Live",
      Movies: "Films",
      Series: "Series",
      Search: "Zoeken",
      Downloads: "Downloads",
      Settings: "Instellingen",
      Back: "Terug",
    },
    "fr-FR": {
      Home: "Accueil",
      Live: "Direct",
      Movies: "Films",
      Series: "Séries",
      Search: "Rechercher",
      Downloads: "Téléchargements",
      Settings: "Réglages",
      Back: "Retour",
    },
    "de-DE": {
      Home: "Startseite",
      Live: "Live",
      Movies: "Filme",
      Series: "Serien",
      Search: "Suchen",
      Downloads: "Downloads",
      Settings: "Einstellungen",
      Back: "Zurück",
    },
    "es-ES": {
      Home: "Inicio",
      Live: "En directo",
      Movies: "Películas",
      Series: "Series",
      Search: "Buscar",
      Downloads: "Descargas",
      Settings: "Ajustes",
      Back: "Atrás",
    },
  },
);
