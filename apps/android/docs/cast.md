# Play on TV source contract

Android owns its open sender in `apps/android/src/cast/` and its platform networking in
`apps/android/modules/cast/`. It uses Android NSD and a dedicated CASTV2 TLS socket, with no
Google sender SDK or new dependency. Cast native sources compile with the existing player
module and are registered beside Player so they share its one admission and reader hold.

The chooser calls `browseTvs()` and disposes its returned stop function when it closes.
`useTvSearch()` reports searching, actual platform denial or failure. NSD names and models are
untrusted receiver declarations. The target36 route adds no speculative permission prompt.

The existing player exposes `player.cast.state`, `select(tv)`, `cancel()`, `playHere()` and
`setVolume(level)`. Select returns true only after receiver PLAYING and native local detach.
Commands on the existing player route to the current output. State and history use confirmed
receiver positions converted from seconds to milliseconds. Stop, replacement, source removal
and file deletion retire that same admitted attempt. Return-local reuses its admission and
waits for confirmed relay-reader closure; failed cleanup rejects and can be retried.

The first profile sends unencrypted HLS and range-readable MP4/M4V/MOV only. Native file
preflight checks the initial MP4/MOV box and HTTP range response, not receiver codec support.
Playlists are rewritten on every read, including live refresh; keys, foreign schemes and
unsupported declared profiles refuse. Downloaded sidecars are not sent. Embedded receiver
tracks remain unqualified and no remote track-selection API is exposed. There is no remuxer.

A fresh Xtream account check must report at least one spare connection before a source relay
opens. Its upstream reader is serial, under the existing attempt's hold. Unknown budgets,
playlist accounts without accounting, exhausted accounts and failed reads refuse before LOAD
and keep local playback. Provider-reported counts are an observation, not a reservation against
other devices. No additional media admission is made.

The relay binds to the selected socket's private IPv4 route. It accepts GET/HEAD, bounded single
ranges and OPTIONS, uses opaque random per-load capabilities, caps headers, playlists, queued
requests and retained routes, and streams media with backpressure. Provider URLs and headers
stay on the phone. Redirects are consumed locally; credentials do not follow cross-origin
redirects or references and HTTPS never downgrades to HTTP. No upstream error or Location is
forwarded. Revocation rejects new reads before draining sockets and upstream readers. An
uncertain close retains the native hold and reports unconfirmed rather than permitting deletion.

Capabilities last for their active load, including pauses, with no independent expiry timer.
Stop, replacement, disconnect, source removal, foreground exit and teardown revoke them.
Visible-activity lifecycle cleanup runs natively, preserves rotation and visible multi-window
pauses, attempts a bounded receiver STOP and unconditionally closes local networking. It does
not depend on JavaScript running. Buffered receiver media cannot be retracted, including after
process death. TLS encryption on the Cast socket does not authenticate the receiver: this is a
trusted-LAN route, not pairing. Normal upstream HTTPS validation is unchanged.

Source tests use protocol/upstream stand-ins and JVM socket/file contracts on forge. Compilation
proves source integration only. No Android device, actual NSD discovery, receiver launch,
audible/moving playback, live rollover, receiver commands/volume/tracks, installed lifecycle,
Wi-Fi loss, buffered-stop interval or final APK packaging is qualified by these checks. The
separate Watch designer owns user-facing wiring and the accepted Paper design.
