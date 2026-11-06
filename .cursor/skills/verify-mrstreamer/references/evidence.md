## Evidence

Each desktop scenario prints an absolute `.local/verification/<scenario>-<unique>/` directory containing:

- `proof.json`: action timestamps, build/instance identity, observations, limitations, pass/fail and cleanup outcome.
- Before/after PNGs and matching accessibility-tree JSON. Live TV also captures playback and the muted Home preview.
- `electron.log` and a failure screenshot when the window is still reachable.

Website runs retain the same proof, screenshots and accessibility trees, plus `session.log`, under their printed `website-<unique>` directory.

Check `status`, the actual observations and `cleanup`, then visually inspect the retained screenshots. A blank or unfinished screenshot is failed evidence even when DOM assertions pass. Pair the actions with the resulting state and side effects: subscription/database creation, TMDB detail requests, a saved title shown in Watchlist, or decoded video/audio and one provider stream shared by Home and Watch. A decode counter is not audible output, and headless decoding is not GPU or performance acceptance.

Desktop fixtures replace external production API boundaries only. Automatic update checks are off; ambient `MR_STREAMER_*` overrides are discarded except the explicit local ffmpeg path. This is a real built app using mock services, not a dry-run. Manual update checks, receiver discovery and real provider acceptance require their own authorized checks. Keep private credentials and stream URLs in gitignored `.local/`; desktop proof uses fake data only. Inspect evidence before sharing and publish only when authorized.
