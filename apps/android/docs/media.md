# Android media

The existing owner has one ExoPlayer and one MediaSession. Audio and embedded text choices
use Media3 overrides; supported selections come from track events. Live quality is offered
only for multiple supported video tracks. Automatic clears that override. Non-live titles,
catch-up and files support speed. Audio focus and noisy routes use Media3.

The non-exported session service permits playback commands and metadata reads only. Live
permits play/pause and stop; non-live adds seeking, ten-second jumps and Next when supplied.
PiP has pause and, for non-live, ten-second jumps. Home entry is armed while Watch is visible
and playing. Dismissal stops the owner; expansion keeps Watch. Activity recreation reattaches
to the process owner. Playback is not restored after process death. Android draws system
controls and may show a subset of the session actions.

The designer consumes `player.media.state` with `useStore`, alongside `player.state` for
reported tracks, speed and playback. `player.media` exposes audio, text, quality, speed,
PiP, cancellation, retry and error dismissal actions. Accepted commands do not invent
selected state. Preferences save after confirmation. Read/write failures stay visible and
retryable. Track preferences match metadata on another source, never old indices; unavailable
matches leave the default intact. English/Dutch copy lives in `apps/android/src/player/copy.ts`.
`apps/android/src/player/media-controls.tsx` draws Watch's row of text controls, the
countdown, the Audio, Subtitles, Speed and Quality sheets and the refusal dialogs; Watch adds
the picture-in-picture button. Live's Play from start waits for programme times, which Android
Live doesn't have yet.

`player.media.registerNext` takes a synchronous resolver receiving the full current episode
PlayIntent, returning `{ intent, label }` or undefined. Its unsubscribe removes the resolver.
The caller owns version-specific order; the player neither reads Library nor constructs the
next intent. No result means no Next action or countdown. Ended episodes count down using
the shared ten-second default. Pause, seek, Back, Close, source replacement and resolver
registration cancel. Cancel retains manual Play next; a new source resolves its own next item.
Credentials enter only through the existing source resolver.

Fake-native tests cover public state, saved preferences and countdown cancellation. JVM tests
cover track mapping and command limits. These and compilation do not prove decoding, sound,
weak-network recovery, installed PiP dismissal/return, notification delivery, audio focus,
rotation, TalkBack or keyboard/D-pad delivery. Those remain unobserved while the managed Pixel
mismatch is unresolved. The base player's source/read and installed-runtime limits remain.
No device, signing or publication is part of this change.
