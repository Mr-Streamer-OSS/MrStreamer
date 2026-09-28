import type { BridgeApi } from "../shared/ipc.ts";

declare global {
  interface Window {
    /** Typed IPC bridge installed by the preload script. */
    readonly mrStreamer: BridgeApi;
  }
}

export {};
