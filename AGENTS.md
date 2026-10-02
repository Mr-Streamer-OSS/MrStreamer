# Agent notes

Start with [docs/README.md](docs/README.md): it indexes development, architecture, testing, releasing and signing. [Planning](docs/maintainers/README.md) holds the handoff for the current slice.

- Before handing work back: `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test`, the same checks CI runs. Conversion and title tests need `ffmpeg` and `ffprobe` on PATH.
- Check live TV changes in the real app against iptv-org's public playlist, as [testing](docs/maintainers/testing.md#a-real-provider) describes; the suite, measurements, movies and series stay on the fake provider and fake TMDB.
- Provider logins and stream URLs, which contain them, stay in the gitignored `.local/`: never in commits, logs, fixtures or published evidence.
- User-facing text follows the approved direction: true black, white primary text, minimal copy.
- Docs are self-contained: record what outside planning documents settled in the slice handoff, and link only to repository files and public project pages, in code, docs and templates alike.
- Outside contributions are limited to small bug fixes; [CONTRIBUTING.md](CONTRIBUTING.md) is the policy.
