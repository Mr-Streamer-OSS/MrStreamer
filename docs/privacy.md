# Privacy policy

Last updated 2 October 2026. The current version is at <https://mrstreamer.app/privacy>.

Mr. Streamer is a free, open-source desktop player for the IPTV subscription you already have. This policy explains what it stores on your computer, what it sends and to whom, and what we receive.

Data controller: Wout Stiens, Belgium, publishing as Mr Streamer OSS. Contact: privacy@mrstreamer.app.

## Summary

- Mr. Streamer sends us nothing. It has no account, no analytics, no telemetry and no crash reporting.
- Your login, settings, favourites and viewing history are stored only on your computer.
- To play anything, the app connects to your provider, which receives your login and can see what you watch. Images and film information come from other services, and update checks go to GitHub.
- If your provider has no encrypted address, your login is sent unencrypted. The app tells you before it does this.

## Data stored on your computer

Mr. Streamer keeps its data in one folder:

| System                  | Folder                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| macOS                   | `~/Library/Application Support/Mr. Streamer`                                                            |
| Windows                 | `%APPDATA%\Mr. Streamer`                                                                                |
| Windows, from the Store | `%LOCALAPPDATA%\Packages\MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr\LocalCache\Roaming\Mr. Streamer Store` |
| Linux                   | `~/.config/Mr. Streamer`                                                                                |

The folder contains:

- your subscription: the server address, your username, and your password. The password is encrypted with a key held by your system: the macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux. On Linux without a keyring, a fixed key is used, so other programs running under your account can read the password. The server address and username are not encrypted.
- your preferences, including your own TMDB key if you entered one. This key is not encrypted.
- your favourites, the channels you watched, and your progress in movies and episodes
- copies of your provider's channel list, programme guide, and movie and series lists
- information from TMDB about your provider's movies and series
- your update channel
- a diagnostics log of what the app did and how long it took. It contains no server addresses, logins or channel names, and it leaves your computer only if you attach it to an issue or an email.
- a cache of images, at most 64 MB, and other files the app's browser engine keeps for itself

Two items are stored outside this folder: the key that encrypts your password, in your system's keychain, and a downloaded update, in a `mrstreamer-updater` folder in your system's cache folder.

## Data sent from your computer

### Your provider

Mr. Streamer connects to the server address you enter. It does so to check your login (when you connect, each time the app starts, and when you open Settings > Subscription), to load the channel, movie and series lists and the programme guide, to show a title's details, and to play. Every request includes your username and password, because these providers require it. Your provider can see your IP address, the app version, and what you open and watch, and when. Your provider's privacy policy applies to that data.

### Unencrypted connections

An address starting with `https://` is encrypted, and Mr. Streamer never falls back from it to unencrypted http, including through redirects. An address entered without `https://` or `http://` is tried with https first. If that fails, the app stops before sending your login and asks you. Your login is sent over http only if you choose **Connect without encryption**. An address entered with `http://` connects over http, and the login form says so.

Over http, your username and password are sent as plain text, and anyone on your network or between you and your provider can read them. Settings > Subscription marks such a login "not encrypted". If your provider offers an https address, we recommend using it.

### Images

Channel logos, posters and backdrops load from the servers your provider specifies. Film images, episode stills and cast photos load from TMDB. These servers receive your IP address, the image requested, your system language, and a browser identification that includes Mr. Streamer, its version and your operating system. They do not receive your login.

### The Movie Database (TMDB)

When TMDB is enabled, Mr. Streamer asks TMDB about the movies and series your provider lists, in the language you chose, and which streaming services offer them in your country. When you open a title or a season, it requests that title's or season's details. TMDB receives your IP address, those titles, your language and country, and an API key: Mr. Streamer's, or your own if you entered one. TMDB never receives your provider's address or your login. [TMDB's privacy policy](https://www.themoviedb.org/privacy-policy) applies.

### Update checks

About 20 seconds after it starts, and every four hours after that, Mr. Streamer checks GitHub for new versions. GitHub hosts our releases, the update list and this page, and receives your IP address and app version with each check. Updates download only when you choose **Download**. Update checks cannot be turned off in Settings. Copies installed from the Microsoft Store receive updates through the Store. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

### Links

Links in Settings, for example to the website, GitHub or TMDB, open in your web browser, where that browser's and that website's terms apply.

### Your network

As with any app, your network operator and DNS provider can see which servers Mr. Streamer contacts.

Mr. Streamer shows no advertising, does not track you, and does not sell data.

## Data we receive

We receive only what you choose to send us:

- email to privacy@mrstreamer.app, hello@mrstreamer.app or security@mrstreamer.app
- issues and comments on [GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/issues). These are public, so please leave out your server address, username and password.

Our email and hosting providers process these messages and visits to our website on our behalf. We use your messages only to reply to you and to fix the problems you report, based on our legitimate interest in supporting and improving Mr. Streamer (GDPR Article 6(1)(f)). We keep them only as long as that requires, and we do not share them. Anything you post on GitHub is public.

## Deleting your data

- **Remove subscription**, in Settings > Subscription, deletes your login and the copies of your provider's lists and guide. Tick **Also delete favourites, history and progress** to delete that account's favourites, watched channels and progress in movies and episodes as well. Otherwise they remain, and reappear if you connect the same account again.
- **Deleting the folder** listed above removes everything Mr. Streamer stores there. To also remove the password key, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS, or the matching entry in your Linux keyring. The update folder can be deleted as well: `~/Library/Caches/mrstreamer-updater` on macOS, `%LOCALAPPDATA%\mrstreamer-updater` on Windows, or `~/.cache/mrstreamer-updater` on Linux.
- **Uninstalling the app does not delete your data**, so a reinstall continues where you left off. The copy from the Microsoft Store is the exception: uninstalling it deletes its folder.
- To ask us to delete messages or other data we hold about you, email privacy@mrstreamer.app.

## Your rights

The data on your computer stays under your control. We cannot access or delete it, and you can view or delete it at any time as described above.

For personal data we hold, mainly messages you sent us, the GDPR gives you the right to access, correct and erase it, to restrict or object to its use, and to receive a copy. Email privacy@mrstreamer.app and we will respond within one month. For data held by your provider, TMDB or GitHub, contact them directly.

Mr Streamer OSS is based in Belgium. You can lodge a complaint with the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint) or with the data protection authority in your country.

## Changes

We update this policy when what Mr. Streamer stores or sends changes. Previous versions are in its [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).
