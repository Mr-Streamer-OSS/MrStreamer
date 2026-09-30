# Updates and channels

Mr. Streamer only updates when you ask it to, and it asks again before restarting. Your login, preferences and watch history stay through every normal update.

## Update from inside the app

1. Open Settings (⌘, on macOS, Ctrl , on Windows and Linux).
2. Under **Updates**, choose **Check for updates**. If a newer version is available, choose **Update**.
3. The download runs while you keep watching. Its progress also shows in the top bar.
4. When it's ready, choose **Restart to update**, then **Restart now**. Choose **Later** to keep watching; the update waits until you restart it from Settings or the top bar.

On Linux, updating the deb package asks for your password, because installing a package needs administrator rights. The AppImage replaces itself without asking.

## Install a newer version by hand

Download the newer installer from the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases) and install it over the old one, as described in the [README](../../README.md#install). Mr. Streamer keeps its data in a folder of its own (see [Troubleshooting](troubleshooting.md#where-your-data-is)), so your login, preferences and history carry over.

## Stable and Nightly

- **Stable** gets tested releases only.
- **Nightly** gets new builds first, up to four a day when there are changes, and every stable release too. Nightly builds can have rough edges.

The version you download sets your channel on first launch. After that, only your choice under **Updates** in Settings changes it. Installing a stable release while on Nightly keeps you on Nightly.

## Going back to Stable

Choose **Stable** under **Updates** in Settings. Mr. Streamer offers the newest stable release right away, even when it is older than your nightly, and installs it like any other update: your login and preferences stay.

Stable 0.0.1 doesn't show the favourites and watch history of newer versions. They come back when you return to Nightly; favourites you add in 0.0.1 meanwhile don't carry over.
