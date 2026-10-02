# Contributing

Mr. Streamer is in active build-out, and its design and structure still move quickly. For now, contributions are limited to **small bug fixes**: a focused change that makes existing behaviour work as intended, with a test when the behaviour can be tested.

Not accepted at the moment:

- new features or options
- refactors, reformatting or dependency changes beyond what a fix needs
- other large changes, even when they fix a bug

Pull requests outside that scope will be closed, so please don't invest time in them yet. Ideas and feature requests aren't tracked for now either. This policy will be relaxed once the desktop app reaches its first full version.

## Reporting a bug

[Open an issue](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings > About, what you did and what happened. Never include your provider's server address, username or password.

A security problem goes to security@mrstreamer.app instead, as [SECURITY.md](.github/SECURITY.md) describes.

## Fixing a bug

1. Open an issue first, or comment on an existing one, so we agree on the fix before you write it.
2. Set up the app: Node 24, pnpm 11, and `ffmpeg` and `ffprobe` on your PATH. `pnpm install`, then `pnpm dev` runs it. The [development guide](docs/maintainers/development.md) has the details.
3. You don't need a subscription to try live TV: on the Connect screen, choose **Use an M3U link** and paste `https://iptv-org.github.io/iptv/index.m3u`, a public playlist of channels broadcasters stream for free. The tests run against a fake provider. If you use your own subscription, keep its details in the gitignored `.local/` folder and out of commits, issues, logs and screenshots.
4. Keep the change small and limited to the bug. Add a test of the behaviour it fixes where one fits; [testing](docs/maintainers/testing.md) describes the suite and the fake provider.
5. If the fix changes what Mr. Streamer stores on your computer or sends over the network, update the [privacy policy](docs/privacy.md) in the same pull request.
6. Run `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test`, the checks CI runs.
7. Describe the bug and how you checked the fix in the pull request.

The [architecture](docs/maintainers/architecture.md) shows where things live: what runs in the main process, what the window does, and how playback works.

By contributing, you agree that your contribution is licensed under the [GPL-3.0](LICENSE).
