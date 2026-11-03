# Android media

The existing owner has one ExoPlayer and one MediaSession. Audio and embedded text choices
use Media3 overrides; supported selections come from track events. Live quality is offered
only for multiple supported video tracks. Automatic clears that override. Non-live titles,
catch-up and files support speed. Audio focus and noisy routes use Media3.

The non-exported session service permits playback commands and metadata reads only. Live
permits play/pause and stop; non-live adds seeking, ten-second jumps and Next when supplied.
PiP toggles play/pause and, for non-live, ten-second jumps. Home entry is armed while Watch is visible
and playing. Dismissal stops the owner; expansion keeps Watch. Activity recreation reattaches
to the process owner. Playback is not restored after process death. Android draws system
controls and may show a subset of the session actions. Android 13+ notification permission is requested
only on the first in-app departure from Watch, never on Home or PiP entry; denial keeps playback running without a shade notification.
Source replacement retains the session service; final stop removes it. Refused background
service starts leave playback intact.

The designer consumes `player.media.state` with `useStore`, alongside `player.state` for
reported tracks, speed and playback. `player.media` exposes audio, text, quality, speed,
PiP, cancellation, retry and error dismissal actions. Accepted commands do not invent
selected state. Preferences save after confirmation. Read/write failures stay visible and
retryable. Track preferences match metadata on another source, never old indices; unavailable
matches leave the default intact. English/Dutch copy lives in `apps/android/src/player/copy.ts`.
`apps/android/src/player/media-controls.tsx` draws Watch's row of text controls, the
countdown, the Audio, Subtitles, Speed and Quality sheets and the refusal dialogs; Watch adds
the picture-in-picture button when Android permits it. Sheets and dialogs close or stay hidden
in PiP.

`player.media.registerNext` takes a synchronous resolver receiving the full current episode
PlayIntent, returning `{ intent, label }` or undefined. Its unsubscribe removes the resolver.
`apps/android/src/player/next-episode.ts` adapts Library DetailState using the core series order and exact episode version identity,
requiring an exact container. Library does not expose its last-read details, so this function
is exported for its future caller; no production resolver is registered. No result means no Next action or countdown. Ended episodes count down using
the shared ten-second default and a deadline that catches up after suspended timers.
Only a visible Watch starts a countdown. Pause, seek, Back, Close, source replacement and resolver
registration cancel a running countdown or ended state; resuming playback clears cancellation.
Leaving Watch before the end prevents a late ended event from starting a countdown. Cancel retains manual Play next; a new source resolves its own next item.
Credentials enter only through the existing source resolver.

Play from start is not offered.

Fake-native tests cover public state, saved preferences and countdown cancellation. JVM tests
cover track mapping and command limits. These and compilation do not prove decoding, sound,
weak-network recovery, installed PiP dismissal/return, notification delivery, audio focus,
rotation, TalkBack or keyboard/D-pad delivery. Those remain unobserved while the managed Pixel
mismatch is unresolved. The base player's source/read and installed-runtime limits remain.
No device, signing or publication is part of this change.
