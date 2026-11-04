# Android programme reminders

The Android app targets API 36, compiles with API 37 and supports API 26+.
Its native reminder module stores programme identity, title, channel name, times,
language and delivery state in an atomic file in Android's no-backup directory.
It stores no provider login or stream URL. Removing the app or clearing its data
removes reminders; backup transfer does not restore them.

## Access and store eligibility

On Android 12+ the module checks `canScheduleExactAlarms()` and uses
`SCHEDULE_EXACT_ALARM`. Most new installs targeting API 33+ on Android 14+
start with this access denied, including backup restores. An existing grant can
survive an OS upgrade. Android 8–11 require no exact-alarm permission.
Notification access, including the Programme reminders channel, is required on
all versions; Android 13+ also has the runtime notification permission.
[Android 14 changes](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms)
and [alarm guidance](https://developer.android.com/develop/background-work/services/alarms)
describe these platform rules.

The module never declares `USE_EXACT_ALARM`. Google Play restricts that permission
to qualifying core alarm/timer or calendar functionality and recommends evaluating
user-granted `SCHEDULE_EXACT_ALARM` for other use cases. This implementation
chooses that route; it is not evidence of Play acceptance or publication approval.
See [Google Play exact-alarm policy](https://support.google.com/googleplay/android-developer/answer/16558241#exact_alarm_permission).

## Delivery and recovery

Only the next due instant has a pending exact wakeup alarm. Its receiver drains
all eligible reminders due at that instant and arms the next one. There is no
inexact fallback and no product count cap. The often quoted 500 is an AOSP
Android 11 default for pending alarms per UID, configurable by the system, not
a portable allowance or a reminder list limit. See
[AOSP AlarmManagerService constants](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android11-release/services/core/java/com/android/server/AlarmManagerService.java).
There is no iOS 64-alarm limit here.

The receiver reads the durable queue without JavaScript. Boot after unlock,
clock/time-zone changes, package replacement and exact-alarm permission grants
recheck delivery and scheduling. Revoked access keeps saved rows but suppresses
alarms. The next foreground reconciliation also checks providers and programme
identity against available guide data. A failed guide read retains prior state;
a known changed or missing programme will not notify. Provider removal removes
its reminders when reconciliation completes. Receivers cannot fetch a fresh
guide while JavaScript is stopped, so they use the last reconciled snapshot.

Recovery posts once while the original programme is still on, with elapsed
minutes in its notification, and silently removes ended reminders. Delivery is
marked consumed before posting to prevent duplicate broadcasts. A process crash
between that durable write and notification posting can lose that notification;
Android provides no atomic transaction spanning disk and NotificationManager.
Errors in storage or scheduling are reported in the app and remain retryable.

`setExactAndAllowWhileIdle` can wake the device, but Android's idle quotas still
apply to closely spaced alarms. Doze, battery restrictions and OEM managers can
delay delivery. Force stop cancels pending alarms and prevents receivers from
running until the app is launched again; reminders remain on disk. See
[alarm and idle behavior](<https://developer.android.com/reference/android/app/AlarmManager#setExactAndAllowWhileIdle(int,long,android.app.PendingIntent)>)
and [Android 15 stopped-state changes](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state).
This is an exact scheduling request, not a promise of delivery at a guaranteed
wall-clock second.

Notification extras carry source id, channel id and start time. App navigation
returns to Live then opens that Programme; no playback action is invoked.
Existing playback remains owned by the player.

## Qualification

These are source-level platform and store constraints, checked against the
linked primary documentation on 4 November 2026. JVM tests and an APK build do
not establish receiver delivery, Settings availability on an OEM build,
notification tap navigation, accessibility, or physical-device behavior.
Device evidence belongs in the ticket's separate verification record.
