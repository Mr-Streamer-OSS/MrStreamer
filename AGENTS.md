# Agent notes

[docs/README.md](docs/README.md) indexes the user, contributor and maintainer docs.

- Planning lives in the [GitHub project](https://github.com/orgs/Mr-Streamer-OSS/projects/1): draft cards hold priority, status, acceptance, decisions and evidence, and its README holds the rules (`gh project view 1 --owner Mr-Streamer-OSS --format json --jq .readme`). Record results on the card you work from; bugs go in repository Issues. `gh project item-list` spends much of the GraphQL rate limit every agent shares, so read and edit single cards through `gh api graphql`.
- PostPlan pages, plans and options alike, go on the card they decided. Repository docs, code and templates link only repository files and public pages.
- Before handing work back: `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test`, the same checks CI runs. Conversion and title tests need `ffmpeg` and `ffprobe` on PATH.
- Check live TV changes in the real app against iptv-org's public playlist, as [testing](docs/contributing/testing.md#a-real-provider) describes; the suite, measurements, movies and series stay on the fake provider and fake TMDB.
- Provider logins and stream URLs, which contain them, stay in the gitignored `.local/`: never in commits, logs, fixtures or published evidence.
- User-facing text follows the approved direction: true black, white primary text, minimal copy.
- Outside contributions are limited to small bug fixes; [CONTRIBUTING.md](CONTRIBUTING.md) is the policy.
