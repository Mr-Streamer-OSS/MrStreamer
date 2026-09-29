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

There are two ways back from a nightly build.

**Switch to Stable** keeps the nightly you have and all your data. Nightly builds are usually newer than the latest stable release, so Mr. Streamer won't replace yours with an older version. Settings says when that's the case, and you move to Stable with the first stable release that is newer than your nightly.

**Start fresh on Stable** installs the latest stable release now, even when it is older, and erases this computer's Mr. Streamer data:

- your subscription login
- your preferences
- your watch history
- the channel list

It doesn't touch your provider account or Mr. Streamer on your other devices. Afterwards you connect your subscription again.

It runs in two steps. First Mr. Streamer downloads and checks the stable release; nothing is erased yet, and you can stop at any point. When the download is ready, a final confirmation lists what will be erased. After you tick the box and choose **Erase and restart**, Mr. Streamer installs Stable, and Stable erases the data when it first opens. If Stable doesn't install, nothing is erased: Settings says so, and **Try again** repeats it.
