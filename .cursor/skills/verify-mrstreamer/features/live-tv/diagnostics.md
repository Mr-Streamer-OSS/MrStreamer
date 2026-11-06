# Desktop playback diagnostic context

For codec, native and hardware checks, read [Live playback](playback.md) and [Desktop Live TV baseline](desktop.md).

## Playback diagnostic context from desktop 0.0.16

Playback failures keep the existing single incident across internal retries and output moves. The optional diagnostic context in `stream_error` comes from typed main failures, the selected inspection/conversion plan and the exact engine category. Undetermined inspection and unknown codec families stay unknown; raw decoder/tool text is never used to infer a missing codec. `playback.diagnostic` reads fixed facts from the current session without changing playback or admitting an event. Engine failure and context reads retain the controller's existing generation check before reporting. Run the analytics/open/renderer contracts and the Privacy feature-map loopback scenario on a fresh build, alongside focused playback fixtures when these boundaries change. Confirmed recovery can admit a later incident; superseded, cancelled, preview and opted-out work must not report one. Codec/native/hardware acceptance still needs the checks above.
