package app.mrstreamer.reminders

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Saved programme reminders as one JSON list in noBackupFilesDir, with one exact alarm armed for
 * the soonest due start. One process-wide lock covers JS calls and broadcast delivery. */
object ReminderStore {
  const val CHANNEL = "programme-reminders"
  private const val HEALTH = "reminder-health"

  // Successful posts whose delivery flag still needs to reach disk in this process.
  private val posted = mutableSetOf<String>()
  private var armedAt: Long? = null

  /** Every saved reminder, as the JSON list JS reads. */
  @Synchronized fun list(context: Context): String = JSONArray(read(context)).toString()

  /** Which access is off ("" when none), whether a background recovery failed, and whether
   * Android has a setting to open for the missing access. */
  @Synchronized fun permission(context: Context): Map<String, Any> {
    val missing = notificationAccess(context) ?: if (exact(context)) "" else "exact"
    val canOpen = missing.isNotEmpty() && setting(context, missing).resolveActivity(context.packageManager) != null
    return mapOf("missing" to missing, "failed" to health(context).getBoolean("failed", false), "readFailed" to raw(context).any { !valid(it) }, "canOpen" to canOpen)
  }

  /** The Android setting for [kind]: "exact", "channel" or the app's notifications page. */
  fun setting(context: Context, kind: String): Intent {
    val intent = when (kind) {
      "exact" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))
      "channel" -> Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
      else -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    }
    return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  /** Saves [json] only with full access and a programme still to come; a failed arm or write keeps
   * the previous list and alarm. */
  @Synchronized fun save(context: Context, json: String) {
    val row = JSONObject(json)
    check(permission(context)["missing"] == "") { "permission" }
    check(row.getLong("start") > System.currentTimeMillis() && row.getLong("stop") > row.getLong("start")) { "started" }
    val old = read(context)
    replace(context, old, old.filter { it.getString("id") != row.getString("id") } + row, required = true)
  }

  @Synchronized fun cancel(context: Context, id: String) {
    val old = read(context)
    replace(context, old, old.filter { it.getString("id") != id })
    notifications(context).cancel(id, 0)
  }

  /** Applies guide patches to saved identities only, so a cancellation is never resurrected. */
  @Synchronized fun reconcile(context: Context, json: String) {
    val patches = JSONArray(json)
    val byId = (0 until patches.length()).map { patches.getJSONObject(it) }.associateBy { it.getString("id") }
    val old = read(context)
    val before = JSONArray(old).toString()
    val rows = old.mapNotNull { row ->
      val patch = byId[row.getString("id")] ?: return@mapNotNull row
      if (patch.optBoolean("remove")) return@mapNotNull null
      row.put("status", patch.getString("status"))
      if (patch.has("stop")) row.put("stop", patch.getLong("stop"))
      if (patch.has("changedTitle")) row.put("changedTitle", patch.getString("changedTitle")) else row.remove("changedTitle")
      row
    }
    if (JSONArray(rows).toString() != before) write(context, rows)
  }

  /** Drops ended reminders, posts due rows independently and always attempts to arm the next.
   * A failed post remains retryable; successful posts are persisted individually. */
  @Synchronized fun recover(context: Context, now: Long = System.currentTimeMillis(), forceArm: Boolean = false) {
    if (forceArm) armedAt = null
    val old = read(context)
    val rows = old.filter { it.getLong("stop") > now }
    var failure: Exception? = null
    try {
      val expired = raw(context).any { !valid(it) && it is JSONObject && it.optLong("stop", Long.MAX_VALUE) <= now }
      if (rows.size != old.size || expired) write(context, rows, now)
      if (notificationAccess(context) == null && exact(context)) {
        for (row in rows.filter { pending(it) && it.getLong("start") <= now }) {
          try {
            val id = row.getString("id")
            if (id !in posted) {
              notify(context, row, now)
              posted.add(id)
            }
            row.put("delivered", true)
            try {
              write(context, rows, now)
              posted.remove(id)
            } catch (cause: Exception) {
              row.put("delivered", false)
              throw cause
            }
          } catch (cause: Exception) {
            failure = cause
          }
        }
      }
    } catch (cause: Exception) {
      failure = cause
    } finally {
      try {
        arm(context, rows, now = now)
      } catch (cause: Exception) {
        failure = cause
      }
      health(context).edit().putBoolean("failed", failure != null).commit()
    }
    failure?.let { throw it }
  }

  /** Records that a background recovery failed, for the app to show until the next one succeeds. */
  fun failed(context: Context) {
    health(context).edit().putBoolean("failed", true).commit()
  }

  private fun health(context: Context) = context.getSharedPreferences(HEALTH, 0)

  private fun disk(context: Context) = AtomicFile(File(context.noBackupFilesDir, "programme-reminders.json"))

  private fun raw(context: Context): List<Any> {
    val file = disk(context)
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return emptyList()
    val array = JSONArray(file.openRead().bufferedReader().use { it.readText() })
    return (0 until array.length()).map { array.get(it) }
  }

  /** Unreadable rows stay verbatim on disk and are reported through permission.readFailed.
   * They cannot prevent valid rows from being listed, cancelled or delivered. */
  private fun valid(value: Any): Boolean = try {
    val row = value as JSONObject
    listOf("id", "sourceId", "channelId", "channelName", "title").forEach { row.getString(it) }
    row.getLong("start")
    row.getLong("stop")
    row.getBoolean("delivered")
    check(row.getString("status") in listOf("scheduled", "changed", "missing"))
    true
  } catch (_: Exception) { false }

  private fun read(context: Context): List<JSONObject> = raw(context).filter(::valid).map { it as JSONObject }

  private fun write(context: Context, rows: List<JSONObject>, now: Long = System.currentTimeMillis()) {
    val file = disk(context)
    val preserved = raw(context).filter { !valid(it) && !(it is JSONObject && it.optLong("stop", Long.MAX_VALUE) <= now) }
    val stream = file.startWrite()
    try {
      stream.write(JSONArray(rows + preserved).toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
    } catch (cause: Exception) {
      file.failWrite(stream)
      throw cause
    }
  }

  /** Arms then writes [rows]; on failure re-arms [old] and rethrows. */
  private fun replace(context: Context, old: List<JSONObject>, rows: List<JSONObject>, required: Boolean = false) {
    try {
      arm(context, rows, required)
      write(context, rows)
    } catch (cause: Exception) {
      arm(context, old)
      throw cause
    }
  }

  private fun pending(row: JSONObject) = row.optString("status", "scheduled") == "scheduled" && !row.optBoolean("delivered")

  private fun notifications(context: Context): NotificationManager {
    val manager = context.getSystemService(NotificationManager::class.java)
    val name = if (context.resources.configuration.locales[0].language == "nl") "Programmaherinneringen" else "Programme reminders"
    manager.createNotificationChannel(NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT))
    return manager
  }

  /** "notifications" or "channel" when Android won't show reminders, otherwise null. */
  private fun notificationAccess(context: Context): String? {
    val manager = notifications(context)
    return when {
      !manager.areNotificationsEnabled() -> "notifications"
      manager.getNotificationChannel(CHANNEL).importance == NotificationManager.IMPORTANCE_NONE -> "channel"
      else -> null
    }
  }

  private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)

  private fun exact(context: Context) = Build.VERSION.SDK_INT < 31 || alarms(context).canScheduleExactAlarms()

  private fun alarmIntent(context: Context) = PendingIntent.getBroadcast(
    context, 0, Intent(context, ReminderAlarmReceiver::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  /** One exact alarm for the next start or retry, whatever the list's size. Without exact-alarm
   * access it is cleared, or refused when [required]. Scheduling failures propagate. */
  private fun arm(context: Context, rows: List<JSONObject>, required: Boolean = false, now: Long = System.currentTimeMillis()) {
    val access = exact(context)
    check(access || !required) { "permission" }
    val next = rows.filter { pending(it) && it.getLong("stop") > now }.minOfOrNull {
      if (it.getLong("start") > now) it.getLong("start") else minOf(it.getLong("stop"), now + 60000)
    }
    if (!access || next == null) {
      alarms(context).cancel(alarmIntent(context))
      armedAt = null
      return
    }
    if (armedAt == next && next > now) return
    alarms(context).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, alarmIntent(context))
    armedAt = next
  }

  /** Posts [row]'s notification; its tap opens the app with the programme's identity as an extra. */
  private fun notify(context: Context, row: JSONObject, now: Long) {
    val id = row.getString("id")
    val identity = JSONObject()
      .put("sourceId", row.getString("sourceId"))
      .put("channelId", row.getString("channelId"))
      .put("start", row.getLong("start"))
      .put("stop", row.getLong("stop"))
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: error("launch")
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    // A category per reminder keeps each notification's pending intent distinct.
    launch.addCategory("app.mrstreamer.reminder.${Uri.encode(id)}")
    launch.putExtra("reminder", identity.toString())
    val tap = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val minutes = (now - row.getLong("start")) / 60000
    val channel = row.getString("channelName")
    val dutch = row.optString("language") == "nl"
    val body = when {
      minutes > 0 -> if (dutch) "$minutes min geleden begonnen op $channel" else "Started $minutes min ago on $channel"
      dutch -> "Begint nu op $channel"
      else -> "Starting now on $channel"
    }
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(row.getString("title"))
      .setContentText(body)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    notifications(context).notify(id, 0, notification)
  }
}

/** The armed alarm: delivers what is due at its own time. */
class ReminderAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = recover(context, goAsync())
}

/** Boot, clock, time zone, app update and exact-alarm grant: re-checks every reminder. */
class ReminderRecoveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = recover(context, goAsync())
}

private fun recover(context: Context, pending: BroadcastReceiver.PendingResult) {
  Thread {
    try {
      ReminderStore.recover(context.applicationContext, forceArm = true)
    } catch (_: Exception) {
      // The saved list is kept and retried at the next recovery; the app shows this failure.
      ReminderStore.failed(context)
    } finally {
      pending.finish()
    }
  }.start()
}
