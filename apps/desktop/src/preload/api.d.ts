import type { BridgeApi } from "@mrstreamer/contracts/ipc";

declare global {
  interface Window {
    /** Typed IPC bridge installed by the preload script. */
    readonly mrStreamer: BridgeApi;
  }
}

export {};
