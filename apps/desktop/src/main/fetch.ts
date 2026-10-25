// The main process fetches with undici 7.30.1 rather than the copy in Electron's Node. Electron
// 44.9.3 bundles Node 24.22.0, whose undici 7.29.1 rejects a response that declares more than five
// content codings but leaves its body stream behind: when the server then closes before the body,
// that stream throws an uncaught error (GHSA-xjj6-f33q-929c). Any provider, guide or other server
// main asks can send one, and Electron shows the error in a box that stops main until the viewer
// dismisses it. undici's install() puts its fetch, Request, Response, Headers and FormData in the
// globals' place for all of main, as a matching set, with its WebSocket and EventSource, which
// main doesn't use. It leaves the global dispatcher alone: requests still go through the Agent of
// Node's own copy, already in place when this runs. index.ts imports this before anything else.
// process.versions.undici still names the bundled copy. Node 24.22.1 bundles 7.30.1, so once
// Electron ships it this can go.
import { install } from "undici";

install();
