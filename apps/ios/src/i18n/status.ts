import { catalogue } from "./catalogue.ts";

/**
 * The status line over a tab's lists (loading.tsx), shared by Home, Live, Movies, Series and
 * Search: what loads or failed, by provider. {providers} is the providers' names as a list in
 * the interface language.
 */
export const t = catalogue(
  {
    "Couldn't update channels from {providers}.": "Couldn't update channels from {providers}.",
    "Couldn't update movies and series from {providers}.":
      "Couldn't update movies and series from {providers}.",
    "Couldn't update channels, movies and series from {providers}.":
      "Couldn't update channels, movies and series from {providers}.",
    "Showing the last list.": "Showing the last list.",
    "Showing the last lists.": "Showing the last lists.",
    "Couldn't load channels from {providers}.": "Couldn't load channels from {providers}.",
    "Couldn't load movies and series from {providers}.":
      "Couldn't load movies and series from {providers}.",
    "Couldn't load channels, movies and series from {providers}.":
      "Couldn't load channels, movies and series from {providers}.",
    "Loading channels from {providers}.": "Loading channels from {providers}.",
    "Loading movies and series from {providers}.": "Loading movies and series from {providers}.",
    "Loading channels, movies and series from {providers}.":
      "Loading channels, movies and series from {providers}.",
    "Loading channels.": "Loading channels.",
    "Loading movies.": "Loading movies.",
    "Loading series.": "Loading series.",
    "Loading movies and series.": "Loading movies and series.",
    "Enter the password for {provider} in Settings.":
      "Enter the password for {provider} in Settings.",
    "{providers} unavailable": {
      one: "{providers} unavailable",
      other: "{providers} unavailable",
    },
    "{providers} need passwords": {
      one: "{providers} needs a password",
      other: "{providers} need passwords",
    },
    Retry: "Retry",
    Settings: "Settings",
    Details: "Details",
    "Dismiss provider notice": "Dismiss provider notice",
  },
  {
    "nl-NL": {
      "Couldn't update channels from {providers}.":
        "Zenders van {providers} konden niet worden bijgewerkt.",
      "Couldn't update movies and series from {providers}.":
        "Films en series van {providers} konden niet worden bijgewerkt.",
      "Couldn't update channels, movies and series from {providers}.":
        "Zenders, films en series van {providers} konden niet worden bijgewerkt.",
      "Showing the last list.": "De laatste lijst wordt getoond.",
      "Showing the last lists.": "De laatste lijsten worden getoond.",
      "Couldn't load channels from {providers}.":
        "Zenders van {providers} konden niet worden geladen.",
      "Couldn't load movies and series from {providers}.":
        "Films en series van {providers} konden niet worden geladen.",
      "Couldn't load channels, movies and series from {providers}.":
        "Zenders, films en series van {providers} konden niet worden geladen.",
      "Loading channels from {providers}.": "Zenders van {providers} laden.",
      "Loading movies and series from {providers}.": "Films en series van {providers} laden.",
      "Loading channels, movies and series from {providers}.":
        "Zenders, films en series van {providers} laden.",
      "Loading channels.": "Zenders laden.",
      "Loading movies.": "Films laden.",
      "Loading series.": "Series laden.",
      "Loading movies and series.": "Films en series laden.",
      "Enter the password for {provider} in Settings.":
        "Voer in Instellingen het wachtwoord voor {provider} in.",
      "{providers} unavailable": {
        one: "{providers} niet beschikbaar",
        other: "{providers} niet beschikbaar",
      },
      "{providers} need passwords": {
        one: "{providers} heeft een wachtwoord nodig",
        other: "{providers} hebben wachtwoorden nodig",
      },
      Retry: "Opnieuw",
      Settings: "Instellingen",
      Details: "Details",
      "Dismiss provider notice": "Providermelding sluiten",
    },
    "fr-FR": {
      "Couldn't update channels from {providers}.":
        "Impossible de mettre à jour les chaînes de {providers}.",
      "Couldn't update movies and series from {providers}.":
        "Impossible de mettre à jour les films et séries de {providers}.",
      "Couldn't update channels, movies and series from {providers}.":
        "Impossible de mettre à jour les chaînes, films et séries de {providers}.",
      "Showing the last list.": "La dernière liste reste affichée.",
      "Showing the last lists.": "Les dernières listes restent affichées.",
      "Couldn't load channels from {providers}.":
        "Impossible de charger les chaînes de {providers}.",
      "Couldn't load movies and series from {providers}.":
        "Impossible de charger les films et séries de {providers}.",
      "Couldn't load channels, movies and series from {providers}.":
        "Impossible de charger les chaînes, films et séries de {providers}.",
      "Loading channels from {providers}.": "Chargement des chaînes de {providers}.",
      "Loading movies and series from {providers}.":
        "Chargement des films et séries de {providers}.",
      "Loading channels, movies and series from {providers}.":
        "Chargement des chaînes, films et séries de {providers}.",
      "Loading channels.": "Chargement des chaînes.",
      "Loading movies.": "Chargement des films.",
      "Loading series.": "Chargement des séries.",
      "Loading movies and series.": "Chargement des films et séries.",
      "Enter the password for {provider} in Settings.":
        "Saisissez le mot de passe de {provider} dans Réglages.",
      "{providers} unavailable": {
        one: "{providers} indisponible",
        other: "{providers} indisponibles",
      },
      "{providers} need passwords": {
        one: "{providers} demande un mot de passe",
        other: "{providers} demandent des mots de passe",
      },
      Retry: "Réessayer",
      Settings: "Réglages",
      Details: "Détails",
      "Dismiss provider notice": "Fermer l’avis du fournisseur",
    },
    "de-DE": {
      "Couldn't update channels from {providers}.":
        "Sender von {providers} konnten nicht aktualisiert werden.",
      "Couldn't update movies and series from {providers}.":
        "Filme und Serien von {providers} konnten nicht aktualisiert werden.",
      "Couldn't update channels, movies and series from {providers}.":
        "Sender, Filme und Serien von {providers} konnten nicht aktualisiert werden.",
      "Showing the last list.": "Die letzte Liste wird angezeigt.",
      "Showing the last lists.": "Die letzten Listen werden angezeigt.",
      "Couldn't load channels from {providers}.":
        "Sender von {providers} konnten nicht geladen werden.",
      "Couldn't load movies and series from {providers}.":
        "Filme und Serien von {providers} konnten nicht geladen werden.",
      "Couldn't load channels, movies and series from {providers}.":
        "Sender, Filme und Serien von {providers} konnten nicht geladen werden.",
      "Loading channels from {providers}.": "Sender von {providers} werden geladen.",
      "Loading movies and series from {providers}.":
        "Filme und Serien von {providers} werden geladen.",
      "Loading channels, movies and series from {providers}.":
        "Sender, Filme und Serien von {providers} werden geladen.",
      "Loading channels.": "Sender werden geladen.",
      "Loading movies.": "Filme werden geladen.",
      "Loading series.": "Serien werden geladen.",
      "Loading movies and series.": "Filme und Serien werden geladen.",
      "Enter the password for {provider} in Settings.":
        "Gib in den Einstellungen das Passwort für {provider} ein.",
      "{providers} unavailable": {
        one: "{providers} nicht verfügbar",
        other: "{providers} nicht verfügbar",
      },
      "{providers} need passwords": {
        one: "{providers} braucht ein Passwort",
        other: "{providers} brauchen Passwörter",
      },
      Retry: "Erneut versuchen",
      Settings: "Einstellungen",
      Details: "Details",
      "Dismiss provider notice": "Anbieterhinweis schließen",
    },
    "es-ES": {
      "Couldn't update channels from {providers}.":
        "No se pudieron actualizar los canales de {providers}.",
      "Couldn't update movies and series from {providers}.":
        "No se pudieron actualizar las películas y series de {providers}.",
      "Couldn't update channels, movies and series from {providers}.":
        "No se pudieron actualizar los canales, películas y series de {providers}.",
      "Showing the last list.": "Se muestra la última lista.",
      "Showing the last lists.": "Se muestran las últimas listas.",
      "Couldn't load channels from {providers}.":
        "No se pudieron cargar los canales de {providers}.",
      "Couldn't load movies and series from {providers}.":
        "No se pudieron cargar las películas y series de {providers}.",
      "Couldn't load channels, movies and series from {providers}.":
        "No se pudieron cargar los canales, películas y series de {providers}.",
      "Loading channels from {providers}.": "Cargando canales de {providers}.",
      "Loading movies and series from {providers}.": "Cargando películas y series de {providers}.",
      "Loading channels, movies and series from {providers}.":
        "Cargando canales, películas y series de {providers}.",
      "Loading channels.": "Cargando canales.",
      "Loading movies.": "Cargando películas.",
      "Loading series.": "Cargando series.",
      "Loading movies and series.": "Cargando películas y series.",
      "Enter the password for {provider} in Settings.":
        "Introduce la contraseña de {provider} en Ajustes.",
      "{providers} unavailable": {
        one: "{providers} no disponible",
        other: "{providers} no disponibles",
      },
      "{providers} need passwords": {
        one: "{providers} necesita una contraseña",
        other: "{providers} necesitan contraseñas",
      },
      Retry: "Reintentar",
      Settings: "Ajustes",
      Details: "Detalles",
      "Dismiss provider notice": "Descartar aviso del proveedor",
    },
  },
);
