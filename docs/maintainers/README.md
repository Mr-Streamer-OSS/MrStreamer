# Planning

> For maintainers. The [docs index](../README.md) lists every guide.

Work is planned in slices. Start with [Slice 03: live TV discovery and programme guide](slices/03-live-tv-and-guide.md), built and waiting for Wout's Mac and Windows checks. Its handoff records the decisions, evidence and known gaps. [Slice 02](slices/02-reliability-and-releases.md) is complete.

The [idea and roadmap](https://r3b736io0gst.postplan.dev) owns the product direction and links the other slices. The [slice 03 options and final scope](https://7pmlwdmw15ie.postplan.dev) is the current design reference; keep it and the repository handoff aligned when scope changes.

## Current sequence

1. Slice 01 delivered the desktop baseline on Mac, Windows and Linux.
2. Slice 02 is complete: the repository is public at [Mr-Streamer-OSS/MrStreamer](https://github.com/Mr-Streamer-OSS/MrStreamer) and nightlies publish automatically. Stable 0.0.1 was published on 30 September from nightly `.15`'s commit. Wout reports successful Mac and Windows testing.
3. Slice 03 fixed the late update check and Stable release notes (#5), and adds the programme guide, favourites, the muted live Home and desktop navigation. Wout tests it on Mac and Windows before it merges; Linux packages are checked headless, and GPU playback measurements remain follow-up evidence.

## Roadmap adjustments

- Slice 02 delivered playback compatibility, library reliability, Mac signing/notarization, the DMG redesign, automatic nightlies with manual Stable promotion, in-app updates and documentation for public launch. Its clean-state reset was later removed: returning to Stable keeps the data.
- User documentation and maintainer/agent documentation must have separate entry points. During the active build-out, code contributions are limited to small bug fixes; document this policy for prospective contributors.
- Additional provider types and multiple subscriptions remain deferred. Their old placement in the slice 02 outline does not authorize implementing them now.
- Slice 03 covers live TV and the guide, and brought forward the muted live Home, programme-first presentation, desktop navigation and copy cleanup. Slice 04 retains movies and series; slice 05 the wider Home integration and remaining everyday controls.
- Slice 06 consolidates quality checks across Mac, Windows and Linux. Each slice still verifies its own behaviour.
- Slice 07 covers distribution follow-up for desktop v1. Release automation and updating are delivered in slice 02; the first public release can happen after slice 02 without waiting for slice 07.
- Slice 08 retains beta feedback and desktop v1 acceptance.
- Slice 09 is a future Linux coverage review. Linux packaging and the current supported Linux workflow are already required in slices 01-02. Additional distributions or architectures need separate scope.
- Slice 10 retains mobile and TV exploration.
