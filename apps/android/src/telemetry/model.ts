import { type } from "arktype";
import { type AnalyticsAction, type AnalyticsFeature } from "@mrstreamer/contracts/analytics";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

// The Android app's product events: the desktop's event names, properties and literals
// (docs/telemetry.md) wherever the Android app has the same observation, under its own build
// dimensions. Nothing here names a device, a person, a provider or anything played.

/** The desktop's actions the Android app can observe. Its other actions have no Android feature yet. */
export const androidActions = [
  "playlist_added",
  "playlist_removed",
  "playlist_refreshed",
] as const satisfies readonly AnalyticsAction[];

export type AndroidAction = (typeof androidActions)[number];

/**
 * The desktop's screens the Android app counts. Its Watchlist screen counts as none of them: the
 * desktop's watchlist feature isn't among these.
 */
export const androidFeatures = [
  "live_tv",
  "settings",
] as const satisfies readonly AnalyticsFeature[];

export type AndroidFeature = (typeof androidFeatures)[number];

/** Which build sends, and the Android major version. No model, locale or other device detail. */
export const AndroidBuild = lazy(() =>
  type({
    app_version: /^(?:\d+\.\d+\.\d+|unknown)$/,
    app_build: /^(?:\d{1,9}|unknown)$/,
    os: "'android'",
    "os_major?": "8 <= number.integer <= 99",
  }).onUndeclaredKey("delete"),
);

export type AndroidBuild = Infer<typeof AndroidBuild>;

const Common = lazy(() =>
  AndroidBuild()
    .merge({ $process_person_profile: "false", $geoip_disable: "true" })
    .onUndeclaredKey("delete"),
);

type CommonProperties = Infer<typeof Common>;

const Day = /^\d{4}-\d{2}-\d{2}$/;

function event<const Name extends string, Properties extends object>(
  name: type.Any<Name>,
  properties: type.Any<Properties>,
) {
  return type({
    uuid: "string.uuid",
    distinct_id: "string.uuid",
    timestamp: "string.date.iso",
    event: name,
    properties,
  }).onUndeclaredKey("delete");
}

/** Every capture: one fixed name with its own fixed property set. Unknown keys are deleted. */
export const CaptureEvent = lazy(() =>
  event(type.unit("installation_observed"), Common())
    .or(
      event(
        type.unit("app_active_day"),
        Common().merge({ activity_date: Day }).onUndeclaredKey("delete"),
      ),
    )
    .or(event(type.enumerated(...androidActions), Common()))
    .or(
      event(
        type.unit("feature_opened"),
        Common()
          .merge({ feature: type.enumerated(...androidFeatures) })
          .onUndeclaredKey("delete"),
      ),
    ),
);

export type CaptureEvent = Infer<typeof CaptureEvent>;

export type CaptureName = CaptureEvent["event"];

export type CaptureOf<Name extends CaptureName> = CaptureEvent & { event: Name };

/** An event's own properties, by name, before the common build dimensions are added. */
export type EventProperties<Name extends CaptureName> =
  CaptureOf<Name>["properties"] extends infer Properties
    ? Properties extends unknown
      ? Omit<Properties, keyof CommonProperties>
      : never
    : never;

/** Platform.Version is an API level on Android; Release is the operating system version. */
export function androidBuild(release: string, version: string, build: string): AndroidBuild {
  const parsed = AndroidBuild()({
    os: "android",
    os_major: Number.parseInt(release, 10),
    app_version: version,
    app_build: build,
  });

  return parsed instanceof type.errors
    ? { os: "android", app_version: "unknown", app_build: "unknown" }
    : parsed;
}
