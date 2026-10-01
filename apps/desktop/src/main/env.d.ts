// Types for the imports electron-vite resolves at build time, such as `?nodeWorker`.
/// <reference types="electron-vite/node" />

/** The app's TMDB key, built in from MR_STREAMER_TMDB_KEY; empty when the build had none. */
declare const __TMDB_KEY__: string;
