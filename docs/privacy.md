# Privacy policy

Last updated 7 October 2026. The current version is at <https://mrstreamer.app/privacy>.

Mr. Streamer is a free, open-source desktop player for the IPTV subscription you already have. This policy explains what it stores on your computer, what it sends and to whom, and what we receive.

Data controller: Wout Stiens, Belgium, publishing as Mr Streamer OSS. Contact: privacy@mrstreamer.app.

## Summary

- Mr. Streamer sends us nothing. It has no account, no analytics, no telemetry and no crash reporting.
- Your login, settings, favourites, watchlist and viewing history are stored only on your computer.
- To play anything, the app connects to the provider or playlist you add, and the servers it points to. They can see what you watch, and a provider receives your login. Images and film information come from other services, and update checks go to GitHub.
- If your provider has no encrypted address, your login is sent unencrypted. The app tells you before it does this.
- A programme guide you add from another address is downloaded from that address's server. It receives the address and your IP address, and never your login.
- When you play on a TV, the TV fetches the stream from your computer over your local network. It never receives your login or your provider's address.

## Data stored on your computer

Mr. Streamer keeps its data in one folder:

| System                  | Folder                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| macOS                   | `~/Library/Application Support/Mr. Streamer`                                                            |
| Windows                 | `%APPDATA%\Mr. Streamer`                                                                                |
| Windows, from the Store | `%LOCALAPPDATA%\Packages\MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr\LocalCache\Roaming\Mr. Streamer Store` |
| Linux                   | `~/.config/Mr. Streamer`                                                                                |

The folder contains:

- your subscriptions, each with its server address, your username, and your password, or the link of a playlist you added, which has no password. The password and the playlist link are encrypted with a key held by your system: the macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux. On Linux without a keyring, a fixed key is used, so other programs running under your account can read them. The server address and username are not encrypted, and neither is the address of the server a playlist comes from. Beside them the app keeps a random id it gives each subscription on this computer, with the server address and username it belongs to and the name you gave it. The id is used only inside the app, where it also names the folder of a subscription you added beside your first, and is never sent anywhere.
- your preferences, including your own TMDB key if you entered one. This key is not encrypted.
- your favourites, the channels you watched, and your progress in movies and episodes
- your watchlist: for each movie or series you saved, and each subscription you saved it from, its name, year and kind, whether the provider marks it for adults, when you saved it, its TMDB id, and the numbers that provider lists its versions under
- copies of each provider's channel list, programme guide, and movie and series lists
- for a subscription you gave a programme guide from another address: that address, the copy of the guide downloaded from it, and the reason its latest download failed, if it did. The address can hold a key, so it is encrypted like a password. Its server's address is not encrypted.
- the channels you mapped to a guide channel by hand: for each, the number your provider lists the channel under, its name, and the guide channel's id
- information from TMDB about your providers' movies and series
- your update channel
- a diagnostics log of what the app did and how long it took. It contains no server addresses, logins or channel names, and it leaves your computer only if you attach it to an issue or an email.
- a cache of images, at most 64 MB, and other files the app's browser engine keeps for itself

Two items are stored outside this folder: the key that encrypts your password or playlist link, in your system's keychain, and a downloaded update, in a `mrstreamer-updater` folder in your system's cache folder.

## Data sent from your computer

### Your provider

Mr. Streamer connects to the server address you enter, for each subscription you add. It does so to check your login (when you add it, each time the app starts, and when you open Settings > Subscriptions), to load the channel, movie and series lists and the programme guide, to show a title's details, and to play. Every request includes your username and password for that provider, because these providers require it. Your provider can see your IP address, the app version, and what you open and watch from it, and when. Your provider's privacy policy applies to that data.

With several subscriptions, each provider receives only its own login and the requests for its own channels and titles. Mr. Streamer puts their lists together on your computer, and tells no provider about another, or what you watch from it.

### Unencrypted connections

An address starting with `https://` is encrypted, and Mr. Streamer never falls back from it to unencrypted http, including through redirects. An address entered without `https://` or `http://` is tried with https first. If that fails, the app stops before sending your login and asks you. Your login is sent over http only if you choose **Connect without encryption**. An address entered with `http://` connects over http, and the login form says so.

Over http, your username and password are sent as plain text, and anyone on your network or between you and your provider can read them. Settings > Subscriptions marks such a login "not encrypted". If your provider offers an https address, we recommend using it.

### A playlist

When you add a playlist link, Mr. Streamer downloads the playlist from that address when you add it, each time the app starts, when you open Settings > Subscriptions, and when it refreshes the channel list or the guide. To play a channel, it connects to the address the playlist lists for that channel, often on another server, and follows that server's redirects, often to further servers. If the playlist names a programme guide, the app downloads it from the server named. Each of these servers receives your IP address and the app version, or the browser identification and referring address the playlist names for that channel. The servers that play a channel can see what you watch, and when. A playlist link without a login sends no username or password. A channel listed with an `http://` address plays unencrypted.

### A guide from another address

If you give a subscription a programme guide from an address of your own, Mr. Streamer downloads the guide from that address: when you choose **Check**, when you refresh it, and about every six hours while it is that subscription's guide. The address's server, and any server it redirects to, receives your IP address, the app version and the address itself, with any key in it. It never receives your provider's address or login, and the app sends it nothing about your channels or what you watch. An address starting with `http://` is sent unencrypted, key included, and the form says so before the first request. Mr. Streamer never follows a redirect from an `https://` address to an `http://` one.

### Images

Channel logos, posters and backdrops load from the servers your provider or playlist specifies. Film images, episode stills and cast photos load from TMDB. These servers receive your IP address, the image requested, your system language, and a browser identification that includes Mr. Streamer, its version and your operating system. They do not receive your login.

### The Movie Database (TMDB)

When TMDB is enabled, Mr. Streamer asks TMDB about the movies and series your providers list, in the language you chose, and which streaming services offer them in your country. When you open a title or a season, it requests that title's or season's details. TMDB receives your IP address, those titles, your language and country, and an API key: Mr. Streamer's, or your own if you entered one. TMDB never receives your provider's address or your login. [TMDB's privacy policy](https://www.themoviedb.org/privacy-policy) applies.

### Update checks

About 20 seconds after it starts, and every four hours after that, Mr. Streamer checks GitHub for new versions. GitHub hosts our releases and the update list, and receives your IP address and app version with each check. Updates download only when you choose **Download**. Update checks cannot be turned off in Settings. Copies installed from the Microsoft Store receive updates through the Store. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

### A TV on your network

Mr. Streamer can play on a TV or other receiver on your local network: with Google Cast on Windows, and with AirPlay on macOS. Nothing here happens until you open the list of receivers.

- **Finding receivers.** On Windows, while the list is open, Mr. Streamer asks your local network which Google Cast devices are there (mDNS). The devices that answer send their name and address, which stay in memory. On macOS, the system finds AirPlay receivers and shows its own list; Mr. Streamer learns only whether one exists, not which.
- **What the receiver gets.** The receiver gets an address on your computer that holds a random token, and fetches the stream from it over your local network, unencrypted. The address works only while that stream plays, and only for devices on your local network. A Cast device also gets the name of what plays and, for movies and series, the address of its picture at TMDB, which the device loads itself. The receiver never gets your login, your provider's address or your playlist link: your computer fetches from the provider and passes the stream on.
- **Google and Apple.** A Cast device runs Google's media receiver, which it loads from Google, and Google's terms apply to what the device reports. Mr. Streamer connects to a Cast device without verifying that Google certified it. AirPlay is handled by macOS and the receiver, under Apple's terms.
- **Other devices on your network.** While a receiver plays, a device on your local network that learns the stream's address, which is random and changes with every stream, could fetch that stream too.

Your provider still sees one connection, from your computer.

### Links

Links in Settings, for example to the website, GitHub or TMDB, open in your web browser, where that browser's and that website's terms apply.

### Your network

As with any app, your network operator and DNS provider can see which servers Mr. Streamer contacts.

Mr. Streamer shows no advertising, does not track you, and does not sell data.

## The website

The website at mrstreamer.app is hosted by Vercel and uses Vercel Web Analytics to count visits and page views. Vercel processes the page URL, referrer, approximate location, device and browser information. We see aggregate traffic statistics. It uses no analytics cookies; its visitor identifier is discarded after 24 hours. See [Vercel's Web Analytics privacy information](https://vercel.com/docs/analytics/privacy-policy).

To link the newest installers, the home page asks GitHub for the public list of releases, the one the app reads for its update checks. GitHub receives your IP address, your browser's identification and that the request came from mrstreamer.app. The request carries no cookie and nothing that identifies you to us. The download buttons and the Microsoft Store badge are links. Nothing goes to GitHub or Microsoft for them until you follow one. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

Website analytics do not receive your IPTV login or viewing history from the desktop app. The desktop app has no analytics or telemetry.

## Data we receive

Apart from the website statistics above, we receive what you choose to send us:

- email to privacy@mrstreamer.app, hello@mrstreamer.app or security@mrstreamer.app
- issues and comments on [GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/issues). These are public, so please leave out your server address, username and password.

Our email and hosting providers process these messages and visits to our website on our behalf. We use your messages only to reply to you and to fix the problems you report, based on our legitimate interest in supporting and improving Mr. Streamer (GDPR Article 6(1)(f)). We keep them only as long as that requires, and we do not share them. Anything you post on GitHub is public.

## Deleting your data

- **Remove**, on a subscription in Settings > Subscriptions, deletes that subscription's login or playlist link, the id and the name the app kept for it, the copies of its provider's lists and guide, and a guide address you gave it with the copy of that guide and the channels you mapped. Your other subscriptions keep theirs. Tick **Also delete favourites, watchlist, history and progress** to delete that account's favourites, watchlist, watched channels and progress in movies and episodes as well. Otherwise they remain, and reappear if you add the same account again.
- **Use provider guide**, or **Use playlist guide**, in a subscription's Guide form deletes the guide address you gave it, the copy of that guide and the channels you mapped.
- **Deleting the folder** listed above removes everything Mr. Streamer stores there. To also remove the password key, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS, or the matching entry in your Linux keyring. The update folder can be deleted as well: `~/Library/Caches/mrstreamer-updater` on macOS, `%LOCALAPPDATA%\mrstreamer-updater` on Windows, or `~/.cache/mrstreamer-updater` on Linux.
- **Uninstalling the app does not delete your data**, so a reinstall continues where you left off. The copy from the Microsoft Store is the exception: uninstalling it deletes its folder.
- To ask us to delete messages or other data we hold about you, email privacy@mrstreamer.app.

## Your rights

The data on your computer stays under your control. We cannot access or delete it, and you can view or delete it at any time as described above.

For personal data we hold, mainly messages you sent us, the GDPR gives you the right to access, correct and erase it, to restrict or object to its use, and to receive a copy. Email privacy@mrstreamer.app and we will respond within one month. For data held by your provider, the servers a playlist names, the server of a guide address you gave, TMDB or GitHub, contact them directly.

Mr Streamer OSS is based in Belgium. You can lodge a complaint with the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint) or with the data protection authority in your country.

## Changes

We update this policy when what Mr. Streamer stores or sends changes. Previous versions are in its [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).
