# Privacy policy

Last updated 2 October 2026. This policy lives at <https://mrstreamer.app/privacy>.

Mr. Streamer is a free, open-source player for the IPTV subscription you already have. I'm Wout Stiens, an individual in Belgium, and I publish it. For anything about your privacy, email privacy@mrstreamer.app.

## In short

- Mr. Streamer sends me nothing. It has no account, no analytics, no telemetry and no crash reporting.
- Your login, settings, favourites and history are stored only on your computer.
- To play anything, it talks to your provider. Your provider gets your login and sees what you watch. Pictures and film details come from other services, and update checks go to GitHub.
- If your provider has no encrypted address, your login travels as plain text. Mr. Streamer tells you before it sends it that way.

## What stays on your computer

Almost everything Mr. Streamer keeps is in one folder:

| System  | Folder                                       |
| ------- | -------------------------------------------- |
| macOS   | `~/Library/Application Support/Mr. Streamer` |
| Windows | `%APPDATA%\Mr. Streamer`                     |
| Linux   | `~/.config/Mr. Streamer`                     |

It holds:

- your subscription: the server address, your username, and your password, encrypted with a key your system keeps (the macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux). On Linux without a keyring, the key is a fixed one, so other programs running as you can read the password. The server address and username aren't encrypted.
- your preferences, including your own TMDB key if you entered one. That key isn't encrypted.
- your favourites, the channels you watched, and how far you got in movies and episodes
- copies of your provider's channel list, programme guide and movie and series lists
- what TMDB said about your provider's movies and series
- your update channel
- a diagnostics log of what the app did and how long it took. It holds no addresses, logins or channel names, and it stays on your computer unless you attach it to an issue or email.
- Chromium's cache of pictures, at most 64 MB, and other files Chromium keeps for itself

Two things live elsewhere. The key that encrypts your password is in your system's keychain. A downloaded update waits in a `mrstreamer-updater` folder in your system's cache folder.

## What leaves your computer

**Your provider.** Mr. Streamer connects to the server address you enter: to check your login when you connect, at every start and when you open Settings > Subscription, to load the channel, movie and series lists and the programme guide, to show a title's details, and to play. Every request carries your username and password, because that's how these providers work. Your provider sees your IP address, the Mr. Streamer version, and what you open and watch, when. Your provider's own privacy policy applies to that.

**Unencrypted connections.** An address that starts with `https://` is encrypted, and Mr. Streamer never falls back from it to plain http, redirects included. An address you type without `https://` or `http://` is tried with https first. If that doesn't work, Mr. Streamer stops before sending your login and asks you; only **Connect without encryption** sends it over http. An address you type with `http://` connects that way, and the form says so. Over http, your username and password travel as plain text: anyone on your network, or between you and your provider, can read them. Settings > Subscription marks such a login "not encrypted". If your provider offers an https address, use it.

**Pictures.** Channel logos, posters and backdrops load from wherever your provider says they are, and film pictures and cast photos from TMDB (`image.tmdb.org`). Those servers see your IP address, which picture is shown, your system language, and a browser identification that names Mr. Streamer, its version and your operating system. They don't see your login.

**TMDB.** If The Movie Database (TMDB) is in use, Mr. Streamer asks it about the movies and series your provider lists, in the language you chose, and which streaming services carry them in your country. When you open a title or a season, it asks for that title's or season's details. TMDB sees your IP address, those titles, your language and country, and the API key: Mr. Streamer's own, or yours if you entered one. It never gets your provider's address or your login. [TMDB's privacy policy](https://www.themoviedb.org/privacy-policy) applies.

**Updates.** About 20 seconds after it starts, and then every four hours, Mr. Streamer reads a small file on GitHub Pages that lists the latest versions. If that file is missing, it asks GitHub's API instead. GitHub sees your IP address and your Mr. Streamer version. Updates download only when you choose **Download**, from GitHub Releases. There's no setting to turn the checks off. A copy installed from the Microsoft Store gets its updates from the Store. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

**Links.** Links in Settings, such as the website, GitHub or TMDB, open in your web browser, under that browser's and that site's rules.

**Your network.** As with any app, your network and DNS provider can see which servers Mr. Streamer contacts.

Nothing else: no advertising, no tracking and no data for sale.

## What I receive

Only what you send me yourself:

- email to privacy@mrstreamer.app, hello@mrstreamer.app or security@mrstreamer.app. Cloudflare's Email Routing forwards it to my mailbox.
- issues and comments on [GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/issues). These are public, so leave out your server address, username and password.

The website `mrstreamer.app` runs through Cloudflare, which currently redirects it to GitHub. [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) covers what it logs. I use what you send me only to answer you and to fix what you report. That's my legitimate interest in supporting and improving Mr. Streamer, under Article 6(1)(f) of the GDPR. I keep messages only as long as I need them for that. I don't share them, except with GitHub when you post there yourself.

## Deleting your data

- **Remove subscription**, in Settings > Subscription, deletes your login and the copies of your provider's lists and guide. Your favourites, history and progress stay, and come back if you connect the same account again.
- **Delete the folder** above to remove everything Mr. Streamer keeps. To remove the password's key too, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS, or the matching entry in your Linux keyring. The update folder can go as well: `~/Library/Caches/mrstreamer-updater`, `%LOCALAPPDATA%\mrstreamer-updater` or `~/.cache/mrstreamer-updater`.
- **Uninstalling doesn't delete your data**, so a reinstall picks up where you left off.
- To have me delete an email or anything else I hold, write to privacy@mrstreamer.app.

## Your rights

Data on your computer is yours. I can't see it, reach it or delete it, and you can view or delete it at any time as described above.

For what I hold, mostly messages you sent, the GDPR gives you the right to see it, correct it, have it deleted, restrict or object to how I use it, and take a copy. Email privacy@mrstreamer.app and I'll answer within a month. For what your provider, TMDB, GitHub or Cloudflare hold, ask them.

You can also complain to the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint), or the authority where you live.

## Changes

This page changes when what Mr. Streamer keeps or sends changes. Every earlier version is in its [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).
