// Exposes the typed IPC bridge to the UI. Keep this file free of logic: the main process validates everything.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BridgeApi, IpcEvents } from "@mrstreamer/contracts/ipc";

const api: BridgeApi = {
  invoke: (method, ...args) => ipcRenderer.invoke(method, args[0]),
  on: (event, listener) => {
    const handler = (_event: IpcRendererEvent, payload: IpcEvents[typeof event]) =>
      listener(payload);
    ipcRenderer.on(event, handler);
    return () => {
      ipcRenderer.removeListener(event, handler);
    };
  },
};

contextBridge.exposeInMainWorld("mrStreamer", api);
