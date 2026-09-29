# Mr. Streamer

A desktop player for the IPTV subscription you already have. Connect it once, then browse and search your live channels and watch them full screen. Your login, channel list and preferences stay on your computer.

Mr. Streamer works with providers that offer Xtream Codes access (a server address, username and password, or an M3U link that contains them).

## Download

Get the latest release from the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest).

| System                              | File                                          |
| ----------------------------------- | --------------------------------------------- |
| macOS 13 or later, Apple silicon    | `Mr-Streamer-<version>-mac-arm64.dmg`         |
| Windows 11, 64-bit                  | `Mr-Streamer-<version>-win-x64-setup.exe`     |
| Linux, 64-bit (Ubuntu, Debian)      | `Mr-Streamer-<version>-linux-amd64.deb`       |
| Linux, 64-bit (other distributions) | `Mr-Streamer-<version>-linux-x86_64.AppImage` |

## Install

**macOS:** open the DMG and drag Mr. Streamer to Applications. Open it from Applications.

**Windows:** run the setup file. It installs for your user account only, without asking for administrator rights. Windows SmartScreen may warn that the app is unrecognised, because the installer isn't signed yet: choose **More info**, then **Run anyway**.

**Linux:** install the deb with `sudo apt install ./Mr-Streamer-<version>-linux-amd64.deb`, then start Mr. Streamer from your applications menu. The AppImage runs without installing: make it executable (`chmod +x`) and open it. AppImages need FUSE 2; on Ubuntu, `sudo apt install libfuse2t64` provides it.

## Use

1. Enter your provider's server address, username and password, or paste the M3U link your provider sent. Mr. Streamer checks the login and loads your channels.
2. Pick a channel from Home, browse Live TV by country and category, or search every channel with ⌘K (Ctrl K on Windows and Linux).
3. While watching, the arrow keys switch channels and open the guide, number keys jump to a channel number, F toggles full screen and M mutes. Backspace returns to the previous channel.

Settings (⌘, or Ctrl ,) shows your subscription, refreshes the channel list and holds updates.

## Updates

Mr. Streamer never updates on its own. In Settings, choose **Check for updates**, then **Update**. Once the download is ready, it asks before restarting, so nothing interrupts what you're watching.

There are two channels: **Stable** for tested releases, and **Nightly** for the newest builds. Installing a newer version by hand from the Releases page also keeps your login and preferences. [Updates and channels](docs/user/updates.md) covers switching channels and starting over on Stable.

## Help

- [Updates and channels](docs/user/updates.md)
- [What plays](docs/user/playback.md), including formats that are converted and known limits
- [Troubleshooting](docs/user/troubleshooting.md): login and keychain, installation warnings, where your data is stored

Found a bug? [Report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings, and what happened.

## Development

Mr. Streamer is open source and under active development. Contributions are limited to small bug fixes for now; see [CONTRIBUTING.md](CONTRIBUTING.md). Building, testing and releasing are covered in the [docs](docs/README.md#working-on-mr-streamer).

## License

GPL-3.0. See [LICENSE](LICENSE). Installers include FFmpeg and x264, also under the GPL; their sources are attached to every release.
