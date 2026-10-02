# Troubleshooting

## Where your data is

Mr. Streamer keeps everything on your computer, in one folder:

| System  | Folder                                       |
| ------- | -------------------------------------------- |
| macOS   | `~/Library/Application Support/Mr. Streamer` |
| Windows | `%APPDATA%\Mr. Streamer`                     |
| Linux   | `~/.config/Mr. Streamer`                     |

It holds your subscription with its encrypted password, your preferences, favourites, watch history and how far you got in movies and episodes, copies of your channel list, programme guide and movie and series lists, what TMDB said about your movies and series, your update channel, and a diagnostics log. Chromium's cache of posters and pictures there stays under 64 MB. Uninstalling leaves the folder in place, so a reinstall picks up where you left off. Delete the folder to remove everything but the password's key in your keychain and a downloaded update; the [privacy policy](../privacy.md#deleting-your-data) says where those are.

Your password is encrypted with a key your system keeps: the macOS Keychain, Windows' user encryption, or the desktop keyring on Linux.

## Mr. Streamer asks for my password again

Your system no longer gives Mr. Streamer the key to your saved password. That happens after a keychain reset, when you deny access, or after replacing the app with a differently signed build. Enter the password again; the rest of the login is filled in.

On macOS, if it keeps asking: open Keychain Access, delete the item named **Mr. Streamer Safe Storage**, then quit and reopen Mr. Streamer.

## Windows warns about the installer

The Windows installer isn't code-signed yet, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. Your antivirus may ask as well.

## Linux

- **The AppImage doesn't open:** it needs FUSE 2. On Ubuntu, run `sudo apt install libfuse2t64`. Without it, starting it from a terminal with `--appimage-extract-and-run` also works.
- **The login doesn't stay saved:** Mr. Streamer stores the password key in GNOME Keyring or KWallet. Without either, it uses Chromium's fixed-key encryption instead, so the login still saves, but other programs running as you can read it.

## Channels or login stop working

- **"… has no encrypted connection":** the address you typed doesn't work over https, so Mr. Streamer stopped before sending your login. **Connect without encryption** connects over http instead: your username and password then travel as plain text, so anyone on your network or between you and your provider can read them. If your provider offers an https address, use that. An address you type with `http://` connects over http straight away; the line under the field says so, and Settings > Subscription marks the login "not encrypted".
- **"The server doesn't offer an encrypted connection at this address":** you typed `https://`, and the server answers only over http. Mr. Streamer never falls back to http on its own. Type the address without `https://` to be asked, or with `http://`.
- **"The provider rejected this username or password":** check the login with your provider, then choose **Edit** beside Login in Settings > Subscription.
- **No programme information for a channel:** your provider's guide doesn't cover it. Many providers cover only some channels. When a guide download fails, the last guide stays in use and Mr. Streamer tries again later; the refresh button beside Guide in Settings > Subscription tries now.
- **"Channels unavailable":** the provider didn't send the channel list. **Try again**, or check your internet connection. When a refresh fails, Mr. Streamer keeps showing the last channel list it received, and Settings > Subscription says why the list may be out of date; the refresh button beside Channels tries again.
- **Movies or Series stay empty:** the first load of a large list takes a few seconds. If the provider offers no movies or series, the pages say so. A failed refresh keeps the last lists; Settings > Subscription says why and refreshes them on their own.
- **No genres or streaming services:** they come from TMDB, which takes about a quarter of an hour the first time on a large subscription. Settings > General shows how far it got beside TMDB, or that TMDB refused the key; **Own key…** takes your own. Titles your provider lists without a TMDB id never get them.

## Updates

- **"GitHub is limiting requests":** Mr. Streamer asked GitHub directly, because the update list it normally reads wasn't there, and GitHub allows only so many requests an hour from one network, shared by everyone on it. Mr. Streamer waits until GitHub allows requests again and tries by itself; nothing needs doing.
- **"You seem to be offline":** check your connection; Mr. Streamer tries again later on its own.
- **An update didn't install:** Settings shows why. **Try again** downloads it again, or install it by hand from the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases).

## Still stuck

[Open an issue](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings, and what happened. Leave out your server address, username and password.

`diagnostics.log` in the same folder helps too: what Mr. Streamer did, how long it took and what failed. It holds no addresses, logins or channel names, and never leaves your computer unless you attach it.
