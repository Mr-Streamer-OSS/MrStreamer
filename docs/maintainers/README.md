# Mr. Streamer maintainer planning

Start with [Slice 02: reliable playback and releases](slices/02-reliability-and-releases.md) when planning or implementing the next slice. It records the agreed decisions, task order, acceptance checks and actions reserved for Wout.

The [idea and roadmap](https://r3b736io0gst.postplan.dev) owns the product direction and links the other slices. The [published slice 02](https://tk1ixs600mix.postplan.dev) mirrors the repository handoff; keep both aligned when its scope changes.

## Current sequence

1. Finish the latest slice 01 build and record its acceptance results. Linux is already part of the desktop baseline alongside Mac and Windows.
2. Wout transfers the existing repository into [Mr-Streamer-OSS](https://github.com/Mr-Streamer-OSS). Verify the actual destination before configuring releases.
3. Deliver slice 02 while the repository remains private.
4. Make the repository public for the first good release after slice 02, when Wout authorizes publication.

## Roadmap adjustments

- Slice 02 now includes playback compatibility, library reliability, Mac signing/notarization, the DMG redesign, manual nightly/stable releases, in-app updates and documentation for public launch.
- User documentation and maintainer/agent documentation must have separate entry points. During the active build-out, code contributions are limited to small bug fixes; document this policy for prospective contributors.
- Additional provider types and multiple subscriptions remain deferred. Their old placement in the slice 02 outline does not authorize implementing them now.
- Slices 03-05 retain live TV/EPG, movies/series and Home/everyday controls respectively.
- Slice 06 consolidates quality checks across Mac, Windows and Linux. Each slice still verifies its own behaviour.
- Slice 07 covers distribution follow-up for desktop v1. Release automation and updating are delivered in slice 02; the first public release can happen after slice 02 without waiting for slice 07.
- Slice 08 retains beta feedback and desktop v1 acceptance.
- Slice 09 is a future Linux coverage review. Linux packaging and the current supported Linux workflow are already required in slices 01-02. Additional distributions or architectures need separate scope.
- Slice 10 retains mobile and TV exploration.
