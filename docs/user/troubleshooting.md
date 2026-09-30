# Troubleshooting

## Where your data is

Mr. Streamer keeps everything on your computer, in one folder:

| System  | Folder                                       |
| ------- | -------------------------------------------- |
| macOS   | `~/Library/Application Support/Mr. Streamer` |
| Windows | `%APPDATA%\Mr. Streamer`                     |
| Linux   | `~/.config/Mr. Streamer`                     |

It holds your subscription with its encrypted password, your preferences, favourites and watch history, copies of your channel list and programme guide, and a diagnostics log. Uninstalling leaves the folder in place, so a reinstall picks up where you left off. Delete the folder to remove everything.

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

- **"The provider rejected this username or password":** check the login with your provider, then choose **Edit login** in Settings.
- **No programme information for a channel:** your provider's guide doesn't cover it. Many providers cover only some channels. When a guide download fails, the last guide stays in use and Mr. Streamer tries again later.
- **"Channels unavailable":** the provider didn't send the channel list. **Try again**, or check your internet connection. When a refresh fails, Mr. Streamer keeps showing the last channel list it received, and Settings says why the list may be out of date.

## Still stuck

[Open an issue](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings, and what happened. Leave out your server address, username and password.

`diagnostics.log` in the same folder helps too: what Mr. Streamer did, how long it took and what failed. It holds no addresses, logins or channel names, and never leaves your computer unless you attach it.
