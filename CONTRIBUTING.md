# Contributing

Mr. Streamer is in active build-out, and its design and structure still move quickly. For now, contributions are limited to **small bug fixes**: a focused change that makes existing behaviour work as intended, with a test when the behaviour can be tested.

Not accepted at the moment:

- new features or options
- refactors, reformatting or dependency changes beyond what a fix needs
- other large changes, even when they fix a bug

Pull requests outside that scope will be closed, so please don't invest time in them yet. Ideas and feature requests aren't tracked for now either. This policy will be relaxed once the desktop app reaches its first full version.

## Reporting a bug

[Open an issue](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings, what you did and what happened. Never include your provider's server address, username or password.

## Fixing a bug

1. Open an issue first, or comment on an existing one, so we agree on the fix before you write it.
2. Keep the change small and limited to the bug.
3. Run `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test` before opening the pull request. The [development runbook](docs/maintainers/development.md) explains the setup.
4. Describe the bug and how you checked the fix in the pull request.

By contributing, you agree that your contribution is licensed under the [GPL-3.0](LICENSE).
