// Fixture overlay only. A fresh task-owned container is mandatory; export via its Documents.
import { File, Paths } from "expo-file-system";
import { measurementRecords } from "./measurement-records.ts";

export const recordMeasurement = measurementRecords(
  () => performance.now(),
  (json) => {
    new File(Paths.document, "fixture-playback-observations.json").write(json);
  },
);
