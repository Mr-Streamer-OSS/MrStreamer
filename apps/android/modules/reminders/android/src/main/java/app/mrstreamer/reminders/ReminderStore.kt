package app.mrstreamer.reminders

import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One process-wide lock protects the durable queue from JS operations and broadcast delivery. */
object ReminderStore {
  const val CHANNEL = "programme-reminders"
  private fun disk(c: Context) = AtomicFile(File(c.noBackupFilesDir, "programme-reminders.json"))
  private fun read(c: Context): List<JSONObject> {
    val file = disk(c)
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return emptyList()
    val array = JSONArray(file.openRead().bufferedReader().use { it.readText() })
    return (0 until array.length()).map { array.getJSONObject(it) }
  }
  private fun write(c: Context, rows: List<JSONObject>) {
    val file = disk(c)
    val stream = file.startWrite()
    try {
      stream.write(JSONArray(rows).toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
    } catch (error: Exception) { file.failWrite(stream); throw error }
  }
  private fun notifications(c: Context): NotificationManager {
    val manager = c.getSystemService(NotificationManager::class.java)
    val dutch = c.resources.configuration.locales[0].language == "nl"
    manager.createNotificationChannel(NotificationChannel(CHANNEL, if (dutch) "Programmaherinneringen" else "Programme reminders", NotificationManager.IMPORTANCE_DEFAULT))
    return manager
  }
  private fun alarms(c: Context) = c.getSystemService(AlarmManager::class.java)
  private fun exact(c: Context) = Build.VERSION.SDK_INT < 31 || alarms(c).canScheduleExactAlarms()
  private fun notificationAccess(c: Context): String? {
    val manager = notifications(c)
    return if (!manager.areNotificationsEnabled()) "notifications"
      else if (manager.getNotificationChannel(CHANNEL).importance == NotificationManager.IMPORTANCE_NONE) "channel" else null
  }
  fun setting(c: Context, kind: String): Intent = when (kind) {
    "exact" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${c.packageName}"))
    "channel" -> Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
    else -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.packageName)
  }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  @Synchronized fun permission(c: Context): Map<String, Any> {
    val missing = notificationAccess(c) ?: if (!exact(c)) "exact" else ""
    return mapOf("missing" to missing, "failed" to c.getSharedPreferences("reminder-health", 0).getBoolean("failed", false), "canOpen" to (missing.isNotEmpty() && setting(c, missing).resolveActivity(c.packageManager) != null))
  }
  private fun alarmIntent(c: Context) = PendingIntent.getBroadcast(c, 0, Intent(c, ReminderAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  private fun arm(c: Context, rows: List<JSONObject>, required: Boolean = false) {
    val next = rows.filter { it.optString("status", "scheduled") == "scheduled" && !it.optBoolean("delivered") }.minOfOrNull { it.getLong("start") }
    if (!exact(c) || notificationAccess(c) != null) {
      check(!required) { "permission" }
      alarms(c).cancel(alarmIntent(c)); return
    }
    if (next == null) { alarms(c).cancel(alarmIntent(c)); return }
    // A single pending intent, regardless of queue size. Scheduling failures propagate to callers.
    alarms(c).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, maxOf(System.currentTimeMillis(), next), alarmIntent(c))
  }
  @Synchronized fun list(c: Context): String {
    return JSONArray(read(c)).toString()
  }
  @Synchronized fun save(c: Context, json: String) {
    val row = JSONObject(json)
    check(permission(c)["missing"] == "") { "permission" }
    check(row.getLong("start") > System.currentTimeMillis() && row.getLong("stop") > row.getLong("start")) { "started" }
    val old = read(c)
    val rows = old.filter { it.getString("id") != row.getString("id") } + row
    try { arm(c, rows, true); write(c, rows) }
    catch (error: Exception) { arm(c, old); throw error }
  }
  @Synchronized fun cancel(c: Context, id: String) {
    val old = read(c)
    val rows = old.filter { it.getString("id") != id }
    try { arm(c, rows); write(c, rows) }
    catch (error: Exception) { arm(c, old); throw error }
    notifications(c).cancel(id, 0)
  }
  /** Reconciliation patches existing identities only; never resurrects a cancellation. */
  @Synchronized fun reconcile(c: Context, json: String) {
    val patches = JSONArray(json)
    val byId = (0 until patches.length()).map { patches.getJSONObject(it) }.associateBy { it.getString("id") }
    val rows = read(c).mapNotNull { row ->
      val patch = byId[row.getString("id")] ?: return@mapNotNull row
      if (patch.optBoolean("remove")) null else row.apply {
        put("status", patch.getString("status"))
        if (patch.has("changedTitle")) put("changedTitle", patch.getString("changedTitle")) else remove("changedTitle")
      }
    }
    write(c, rows)
    recover(c)
  }
  @Synchronized fun recover(c: Context, now: Long = System.currentTimeMillis(), recovered: Boolean = true) {
    val rows = read(c).filter { it.getLong("stop") > now }
    val due = if (permission(c)["missing"] == "") rows.filter {
      it.optString("status", "scheduled") == "scheduled" && !it.optBoolean("delivered") && it.getLong("start") <= now
    } else emptyList()
    // Persist the consumed state before posting; repeat broadcasts cannot notify twice.
    due.forEach { it.put("delivered", true) }
    write(c, rows)
    for (row in due) notify(c, row, now, recovered)
    arm(c, rows)
    c.getSharedPreferences("reminder-health", 0).edit().putBoolean("failed", false).commit()
  }
  private fun notify(c: Context, row: JSONObject, now: Long, recovered: Boolean) {
    val id = row.getString("id")
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: error("launch")
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    launch.addCategory("app.mrstreamer.reminder.${Uri.encode(id)}")
    launch.putExtra("reminder", JSONObject().put("sourceId", row.getString("sourceId")).put("channelId", row.getString("channelId")).put("start", row.getLong("start")).toString())
    val tap = PendingIntent.getActivity(c, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val minutes = (now - row.getLong("start")) / 60000
    val name = row.getString("channelName")
    val dutch = row.optString("language") == "nl"
    val body = if (recovered || minutes > 0) { if (dutch) "${minutes} min geleden begonnen op $name" else "Started $minutes min ago on $name" }
      else if (dutch) "Begint nu op $name" else "Starting now on $name"
    notifications(c).notify(id, 0, Notification.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(row.getString("title")).setContentText(body).setContentIntent(tap).setAutoCancel(true).build())
  }
}

class ReminderAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = recover(context, goAsync(), false)
}
class ReminderRecoveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = recover(context, goAsync())
}
private fun recover(context: Context, pending: BroadcastReceiver.PendingResult, recovered: Boolean = true) {
  Thread {
    try { ReminderStore.recover(context.applicationContext, recovered = recovered) }
    catch (_: Exception) {
      // Kept durable state retries at the next recovery; app reads must expose this failure.
      context.getSharedPreferences("reminder-health", 0).edit().putBoolean("failed", true).commit()
    } finally { pending.finish() }
  }.start()
}
