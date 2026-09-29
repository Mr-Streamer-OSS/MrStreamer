# Planning

> For maintainers. The [docs index](../README.md) lists every guide.

Work is planned in slices. [Slice 02: reliable playback and releases](slices/02-reliability-and-releases.md) is complete; its handoff records the decisions, acceptance and known gaps. Slice 03 is next.

The [idea and roadmap](https://r3b736io0gst.postplan.dev) owns the product direction and links the other slices. The [published slice 02](https://tk1ixs600mix.postplan.dev) mirrors the repository handoff; keep both aligned when scope changes.

## Current sequence

1. Slice 01 delivered the desktop baseline on Mac, Windows and Linux.
2. Slice 02 is complete: the repository is public at [Mr-Streamer-OSS/MrStreamer](https://github.com/Mr-Streamer-OSS/MrStreamer), nightlies publish automatically, and Stable 0.0.1 follows once Wout has tested the next nightly.
3. Slice 03, live TV and the EPG, starts next.

## Roadmap adjustments

- Slice 02 now includes playback compatibility, library reliability, Mac signing/notarization, the DMG redesign, automatic nightlies with manual Stable promotion, in-app updates and documentation for public launch.
- User documentation and maintainer/agent documentation must have separate entry points. During the active build-out, code contributions are limited to small bug fixes; document this policy for prospective contributors.
- Additional provider types and multiple subscriptions remain deferred. Their old placement in the slice 02 outline does not authorize implementing them now.
- Slices 03-05 retain live TV/EPG, movies/series and Home/everyday controls respectively.
- Slice 06 consolidates quality checks across Mac, Windows and Linux. Each slice still verifies its own behaviour.
- Slice 07 covers distribution follow-up for desktop v1. Release automation and updating are delivered in slice 02; the first public release can happen after slice 02 without waiting for slice 07.
- Slice 08 retains beta feedback and desktop v1 acceptance.
- Slice 09 is a future Linux coverage review. Linux packaging and the current supported Linux workflow are already required in slices 01-02. Additional distributions or architectures need separate scope.
- Slice 10 retains mobile and TV exploration.
