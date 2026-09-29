# Agent notes

Start with [docs/maintainers/README.md](docs/maintainers/README.md): it indexes development, architecture, testing, releasing and signing, and the planning handoff for the current slice.

- Before handing work back: `pnpm fmt:check`, `pnpm typecheck` and `pnpm test`. Conversion tests need `ffmpeg` and `ffprobe` on PATH.
- Provider logins and stream URLs, which contain them, stay in the gitignored `.local/`: never in commits, logs, fixtures or published evidence.
- User-facing text follows the approved direction: true black, white primary text, minimal copy.
- Outside contributions are limited to small bug fixes; [CONTRIBUTING.md](CONTRIBUTING.md) is the policy.
