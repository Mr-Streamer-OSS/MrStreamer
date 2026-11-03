import { catalogue } from "./catalogue.ts";

/**
 * Play on TV (cast.ts, playback.ts and Watch's TV button and sheet): what the TV route says when
 * it can't play somewhere or stops. TV names stay as the TV gives them; AirPlay and Wi-Fi stay as
 * they are.
 */
export const t = catalogue(
  {
    "Stopped on the TV when you left the app.": "Stopped on the TV when you left the app.",
    "Lost {tv}.": "Lost {tv}.",
    "Couldn't connect to {tv}.": "Couldn't connect to {tv}.",
    "{tv} couldn't play it.": "{tv} couldn't play it.",
    "This file type can't play on a TV.": "This file type can't play on a TV.",
    "Its stream is protected, so it can't play on a TV.":
      "Its stream is protected, so it can't play on a TV.",
    "Its picture or sound can't play on a TV.": "Its picture or sound can't play on a TV.",
    "This channel's stream can't play on a TV.": "This channel's stream can't play on a TV.",
    "Connect this iPhone to Wi-Fi to play on a TV.":
      "Connect this iPhone to Wi-Fi to play on a TV.",
  },
  {
    "nl-NL": {
      "Stopped on the TV when you left the app.": "Gestopt op de tv toen je de app verliet.",
      "Lost {tv}.": "Verbinding met {tv} verbroken.",
      "Couldn't connect to {tv}.": "Kan geen verbinding maken met {tv}.",
      "{tv} couldn't play it.": "{tv} kon het niet afspelen.",
      "This file type can't play on a TV.": "Dit bestandstype kan niet op een tv spelen.",
      "Its stream is protected, so it can't play on a TV.":
        "De stream is beveiligd en kan daarom niet op een tv spelen.",
      "Its picture or sound can't play on a TV.": "Het beeld of geluid kan niet op een tv spelen.",
      "This channel's stream can't play on a TV.":
        "De stream van dit kanaal kan niet op een tv spelen.",
      "Connect this iPhone to Wi-Fi to play on a TV.":
        "Verbind deze iPhone met wifi om op een tv af te spelen.",
    },
    "fr-FR": {
      "Stopped on the TV when you left the app.":
        "Arrêté sur la télé quand vous avez quitté l'app.",
      "Lost {tv}.": "Connexion à {tv} perdue.",
      "Couldn't connect to {tv}.": "Impossible de se connecter à {tv}.",
      "{tv} couldn't play it.": "{tv} n'a pas pu le lire.",
      "This file type can't play on a TV.": "Ce type de fichier ne peut pas être lu sur une télé.",
      "Its stream is protected, so it can't play on a TV.":
        "Son flux est protégé et ne peut donc pas être lu sur une télé.",
      "Its picture or sound can't play on a TV.":
        "Son image ou son son ne peut pas être lu sur une télé.",
      "This channel's stream can't play on a TV.":
        "Le flux de cette chaîne ne peut pas être lu sur une télé.",
      "Connect this iPhone to Wi-Fi to play on a TV.":
        "Connectez cet iPhone au Wi-Fi pour lire sur une télé.",
    },
    "de-DE": {
      "Stopped on the TV when you left the app.":
        "Auf dem Fernseher gestoppt, als du die App verlassen hast.",
      "Lost {tv}.": "Verbindung zu {tv} verloren.",
      "Couldn't connect to {tv}.": "Keine Verbindung zu {tv} möglich.",
      "{tv} couldn't play it.": "{tv} konnte es nicht abspielen.",
      "This file type can't play on a TV.":
        "Dieser Dateityp kann nicht auf einem Fernseher abgespielt werden.",
      "Its stream is protected, so it can't play on a TV.":
        "Der Stream ist geschützt und kann daher nicht auf einem Fernseher abgespielt werden.",
      "Its picture or sound can't play on a TV.":
        "Bild oder Ton können nicht auf einem Fernseher abgespielt werden.",
      "This channel's stream can't play on a TV.":
        "Der Stream dieses Senders kann nicht auf einem Fernseher abgespielt werden.",
      "Connect this iPhone to Wi-Fi to play on a TV.":
        "Verbinde dieses iPhone mit WLAN, um auf einem Fernseher abzuspielen.",
    },
    "es-ES": {
      "Stopped on the TV when you left the app.": "Se detuvo en la tele al salir de la app.",
      "Lost {tv}.": "Se perdió la conexión con {tv}.",
      "Couldn't connect to {tv}.": "No se pudo conectar con {tv}.",
      "{tv} couldn't play it.": "{tv} no pudo reproducirlo.",
      "This file type can't play on a TV.": "Este tipo de archivo no se puede ver en una tele.",
      "Its stream is protected, so it can't play on a TV.":
        "Su emisión está protegida, así que no se puede ver en una tele.",
      "Its picture or sound can't play on a TV.":
        "Su imagen o su sonido no se pueden reproducir en una tele.",
      "This channel's stream can't play on a TV.":
        "La emisión de este canal no se puede ver en una tele.",
      "Connect this iPhone to Wi-Fi to play on a TV.":
        "Conecta este iPhone a una red Wi-Fi para ver en una tele.",
    },
  },
);
