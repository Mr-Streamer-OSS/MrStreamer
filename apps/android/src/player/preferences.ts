import { File, Paths } from "expo-file-system";
import { type } from "arktype";
import { writeJson } from "../platform/storage.ts";
import type { MediaPersistence } from "./media.ts";

const choice = type({
  language: "string | null",
  label: "string | null",
  codec: "string | null",
  height: "number | null",
  bitrate: "number | null",
});

const preferences = type({
  "speed?": "0.25 <= number <= 4",
  "audio?": choice,
  "text?": choice.or("'off'"),
  "quality?": choice.or("'automatic'"),
});

const NAME = "media-preferences.json";

/** A missing file is new state; an unreadable file is an error and is never overwritten. */
export const mediaPersistence: MediaPersistence = {
  read() {
    const file = new File(Paths.document, NAME);

    if (!file.exists) return {};
    const result = preferences(JSON.parse(file.textSync()));

    if (result instanceof type.errors) throw new Error("Invalid media preferences");

    return result;
  },
  write(value) {
    writeJson(NAME, value);
  },
};
