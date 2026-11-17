// Main and the catalogue worker each import this first: threads have separate globals, and
// provider and TMDB clients capture fetch when created. undici's install() supplies fetch and
// matching Request, Response, Headers and FormData, plus the unused WebSocket and EventSource.
// This bootstrap sets no transport options. Undici 8 uses its v2 global dispatcher and can
// negotiate HTTP/2; the app supplies no custom dispatcher handlers or Blob-like objects.
// Electron 45.3.2 pins Node 24.22.2, whose upstream undici 7.30.1 fixes GHSA-xjj6-f33q-929c.
// Keep the replacement until its removal is verified against Electron's patched runtime and
// rejected-response cleanup. process.versions.undici names the bundled copy, not this dependency.
import { install } from "undici";

install();
