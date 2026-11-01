import { catalogue } from "./catalogue.ts";

/** How a provider failed and what to do, as Connect, the provider form and Settings say it (errors.ts). */
export const t = catalogue(
  {
    "Couldn't reach {host}": "Couldn't reach {host}",
    "Check the address and that your iPhone is online.":
      "Check the address and that your iPhone is online.",
    "{host} didn't accept this login": "{host} didn't accept this login",
    "Check the username and password from your provider.":
      "Check the username and password from your provider.",
    "This subscription expired on {date}": "This subscription expired on {date}",
    "This subscription has expired": "This subscription has expired",
    "Renew it with {host}, then try again.": "Renew it with {host}, then try again.",
    "{host} reports this subscription as banned": "{host} reports this subscription as banned",
    "{host} reports this subscription as disabled": "{host} reports this subscription as disabled",
    "Ask {host} about it, then try again.": "Ask {host} about it, then try again.",
    "{host} isn't answering": "{host} isn't answering",
    "This usually passes. Try again in a minute.": "This usually passes. Try again in a minute.",
    "Enter the password for {host} again": "Enter the password for {host} again",
    "Your iPhone no longer gives it back. Enter it in Settings.":
      "Your iPhone no longer gives it back. Enter it in Settings.",
    "Your iPhone wouldn't save the password": "Your iPhone wouldn't save the password",
    "Try again. If it keeps failing, restart the iPhone.":
      "Try again. If it keeps failing, restart the iPhone.",
  },
  {
    "nl-NL": {
      "Couldn't reach {host}": "Kan {host} niet bereiken",
      "Check the address and that your iPhone is online.":
        "Controleer het adres en of je iPhone online is.",
      "{host} didn't accept this login": "{host} accepteerde deze login niet",
      "Check the username and password from your provider.":
        "Controleer de gebruikersnaam en het wachtwoord van je provider.",
      "This subscription expired on {date}": "Dit abonnement is verlopen op {date}",
      "This subscription has expired": "Dit abonnement is verlopen",
      "Renew it with {host}, then try again.": "Verleng het bij {host} en probeer het opnieuw.",
      "{host} reports this subscription as banned": "{host} meldt dit abonnement als geblokkeerd",
      "{host} reports this subscription as disabled":
        "{host} meldt dit abonnement als uitgeschakeld",
      "Ask {host} about it, then try again.": "Vraag {host} ernaar en probeer het opnieuw.",
      "{host} isn't answering": "{host} antwoordt niet",
      "This usually passes. Try again in a minute.":
        "Dit gaat meestal vanzelf over. Probeer het over een minuut opnieuw.",
      "Enter the password for {host} again": "Voer het wachtwoord voor {host} opnieuw in",
      "Your iPhone no longer gives it back. Enter it in Settings.":
        "Je iPhone geeft het niet meer terug. Voer het in bij Instellingen.",
      "Your iPhone wouldn't save the password": "Je iPhone wilde het wachtwoord niet bewaren",
      "Try again. If it keeps failing, restart the iPhone.":
        "Probeer het opnieuw. Blijft het mislukken, herstart dan de iPhone.",
    },
    "fr-FR": {
      "Couldn't reach {host}": "Impossible de joindre {host}",
      "Check the address and that your iPhone is online.":
        "Vérifiez l’adresse et que votre iPhone est en ligne.",
      "{host} didn't accept this login": "{host} n’a pas accepté ces identifiants",
      "Check the username and password from your provider.":
        "Vérifiez le nom d’utilisateur et le mot de passe de votre fournisseur.",
      "This subscription expired on {date}": "Cet abonnement a expiré le {date}",
      "This subscription has expired": "Cet abonnement a expiré",
      "Renew it with {host}, then try again.": "Renouvelez-le auprès de {host}, puis réessayez.",
      "{host} reports this subscription as banned": "{host} indique que cet abonnement est banni",
      "{host} reports this subscription as disabled":
        "{host} indique que cet abonnement est désactivé",
      "Ask {host} about it, then try again.": "Renseignez-vous auprès de {host}, puis réessayez.",
      "{host} isn't answering": "{host} ne répond pas",
      "This usually passes. Try again in a minute.":
        "Cela passe généralement. Réessayez dans une minute.",
      "Enter the password for {host} again": "Saisissez à nouveau le mot de passe de {host}",
      "Your iPhone no longer gives it back. Enter it in Settings.":
        "Votre iPhone ne le restitue plus. Saisissez-le dans Réglages.",
      "Your iPhone wouldn't save the password":
        "Votre iPhone n’a pas voulu enregistrer le mot de passe",
      "Try again. If it keeps failing, restart the iPhone.":
        "Réessayez. Si l’échec persiste, redémarrez l’iPhone.",
    },
    "de-DE": {
      "Couldn't reach {host}": "{host} ist nicht erreichbar",
      "Check the address and that your iPhone is online.":
        "Prüfe die Adresse und ob dein iPhone online ist.",
      "{host} didn't accept this login": "{host} hat diese Anmeldung nicht akzeptiert",
      "Check the username and password from your provider.":
        "Prüfe Benutzername und Passwort deines Anbieters.",
      "This subscription expired on {date}": "Dieses Abo ist am {date} abgelaufen",
      "This subscription has expired": "Dieses Abo ist abgelaufen",
      "Renew it with {host}, then try again.":
        "Verlängere es bei {host} und versuch es dann erneut.",
      "{host} reports this subscription as banned": "{host} meldet dieses Abo als gesperrt",
      "{host} reports this subscription as disabled": "{host} meldet dieses Abo als deaktiviert",
      "Ask {host} about it, then try again.": "Frag bei {host} nach und versuch es dann erneut.",
      "{host} isn't answering": "{host} antwortet nicht",
      "This usually passes. Try again in a minute.":
        "Das geht meist vorbei. Versuch es in einer Minute erneut.",
      "Enter the password for {host} again": "Gib das Passwort für {host} erneut ein",
      "Your iPhone no longer gives it back. Enter it in Settings.":
        "Dein iPhone gibt es nicht mehr heraus. Gib es in den Einstellungen ein.",
      "Your iPhone wouldn't save the password": "Dein iPhone wollte das Passwort nicht speichern",
      "Try again. If it keeps failing, restart the iPhone.":
        "Versuch es erneut. Wenn es weiter fehlschlägt, starte das iPhone neu.",
    },
    "es-ES": {
      "Couldn't reach {host}": "No se puede conectar con {host}",
      "Check the address and that your iPhone is online.":
        "Comprueba la dirección y que tu iPhone tenga conexión.",
      "{host} didn't accept this login": "{host} no aceptó este acceso",
      "Check the username and password from your provider.":
        "Comprueba el usuario y la contraseña de tu proveedor.",
      "This subscription expired on {date}": "Esta suscripción caducó el {date}",
      "This subscription has expired": "Esta suscripción ha caducado",
      "Renew it with {host}, then try again.": "Renuévala con {host} y vuelve a intentarlo.",
      "{host} reports this subscription as banned":
        "{host} indica que esta suscripción está bloqueada",
      "{host} reports this subscription as disabled":
        "{host} indica que esta suscripción está desactivada",
      "Ask {host} about it, then try again.": "Pregunta a {host} y vuelve a intentarlo.",
      "{host} isn't answering": "{host} no responde",
      "This usually passes. Try again in a minute.":
        "Suele pasarse. Vuelve a intentarlo en un minuto.",
      "Enter the password for {host} again": "Vuelve a introducir la contraseña de {host}",
      "Your iPhone no longer gives it back. Enter it in Settings.":
        "Tu iPhone ya no la devuelve. Introdúcela en Ajustes.",
      "Your iPhone wouldn't save the password": "Tu iPhone no quiso guardar la contraseña",
      "Try again. If it keeps failing, restart the iPhone.":
        "Vuelve a intentarlo. Si sigue fallando, reinicia el iPhone.",
    },
  },
);
