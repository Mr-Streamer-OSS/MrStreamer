package app.mrstreamer.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.app.Notification
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Implementation
import org.robolectric.shadows.ShadowNotificationManager
import org.robolectric.shadows.ShadowAlarmManager
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class RemindersTest {
  @Implements(NotificationManager::class)
  class ThrowingNotifications : ShadowNotificationManager() {
    @Implementation override fun notify(tag: String?, id: Int, notification: Notification) {
      if (tag == "one") error("post")
      super.notify(tag, id, notification)
    }
  }
  @Implements(NotificationManager::class)
  class BlockingWriteNotifications : ShadowNotificationManager() {
    companion object { var posts = 0 }
    @Implementation override fun notify(tag: String?, id: Int, notification: Notification) {
      posts++
      super.notify(tag, id, notification)
      val blocked = File(RuntimeEnvironment.getApplication().noBackupFilesDir, "programme-reminders.json.new")
      blocked.mkdirs()
      File(blocked, "block").writeText("block")
    }
  }
  @Implements(AlarmManager::class)
  class ThrowingAlarms : ShadowAlarmManager() {
    companion object { var failNext = false }
    @Implementation override fun setExactAndAllowWhileIdle(type: Int, time: Long, operation: PendingIntent) {
      if (failNext) { failNext = false; error("arm") }
      super.setExactAndAllowWhileIdle(type, time, operation)
    }
  }

  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val alarm get() = shadowOf(context.getSystemService(AlarmManager::class.java))
  private val notifications get() = shadowOf(context.getSystemService(NotificationManager::class.java))
  private fun row(id: String, start: Long, stop: Long) = JSONObject()
    .put("id", id).put("sourceId", "fixture").put("channelId", "channel")
    .put("channelName", "Test channel").put("title", "News")
    .put("status", "scheduled").put("delivered", false).put("start", start).put("stop", stop).toString()

  @Before fun launcher() {
    ReminderStore.recover(context)
    val resolved = ResolveInfo().apply {
      activityInfo = ActivityInfo().apply {
        packageName = context.packageName
        name = "MainActivity"
        applicationInfo = context.applicationInfo
      }
    }
    shadowOf(context.packageManager).addResolveInfoForIntent(
      Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName), resolved)
  }

  @After fun cleanup() {
    listOf("", ".bak", ".new").forEach { File(context.noBackupFilesDir, "programme-reminders.json$it").deleteRecursively() }
    context.getSharedPreferences("reminder-health", 0).edit().clear().commit()
    ThrowingAlarms.failNext = false
    context.getSystemService(NotificationManager::class.java).cancelAll()
    alarm.scheduledAlarms.toList().forEach { context.getSystemService(AlarmManager::class.java).cancel(requireNotNull(it.operation)) }
  }

  @Test fun durableQueueArmsOnlyNextInstantAndCancellationRearms() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("later", now + 120000, now + 600000))
    ReminderStore.save(context, row("first", now + 60000, now + 600000))
    assertEquals(2, JSONArray(ReminderStore.list(context)).length())
    assertEquals(1, alarm.scheduledAlarms.size)
    assertEquals(now + 60000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
    ReminderStore.cancel(context, "first")
    assertEquals(now + 120000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
    assertEquals(1, JSONArray(ReminderStore.list(context)).length())
  }

  @Test fun lateRecoveryDrainsSimultaneousRemindersOnceAndDropsEnded() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 60000, now + 600000))
    ReminderStore.save(context, row("two", now + 60000, now + 600000))
    ReminderStore.save(context, row("ended", now + 1000, now + 30000))
    ReminderStore.recover(context, now + 90000)
    assertEquals(2, notifications.allNotifications.size)
    assertEquals("Starting now on Test channel", notifications.allNotifications.first().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    assertEquals(2, JSONArray(ReminderStore.list(context)).length())
    context.getSystemService(NotificationManager::class.java).cancelAll()
    ReminderStore.recover(context, now + 90000)
    assertEquals(0, notifications.allNotifications.size)
    assertEquals(0, alarm.scheduledAlarms.size)
  }

  /** Each access, notifications then exact alarms: off refuses new saves without dropping saved ones; notification access does not disarm them. */
  @Test @Config(sdk = [35]) fun missingAccessRefusesNewRemindersAndRetainsSavedOnes() {
    val now = System.currentTimeMillis()
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    ReminderStore.save(context, row("saved", now + 60000, now + 600000))
    for ((missing, allowed) in listOf<Pair<String, (Boolean) -> Unit>>(
      "notifications" to { notifications.setNotificationsEnabled(it) },
      "exact" to { ShadowAlarmManager.setCanScheduleExactAlarms(it) },
    )) {
      allowed(false)
      assertEquals(missing, ReminderStore.permission(context)["missing"])
      assertThrows(IllegalStateException::class.java) { ReminderStore.save(context, row("refused", now + 60000, now + 600000)) }
      ReminderStore.recover(context)
      assertEquals(1, JSONArray(ReminderStore.list(context)).length())
      assertEquals(if (missing == "notifications") 1 else 0, alarm.scheduledAlarms.size)
      allowed(true)
      ReminderStore.recover(context)
      assertEquals(1, alarm.scheduledAlarms.size)
    }
  }
  @Test @Config(shadows = [ThrowingNotifications::class])
  fun failedPostDoesNotConsumeOtherDueRowsAndStillArmsFuture() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 60000, now + 600000))
    ReminderStore.save(context, row("two", now + 60000, now + 600000))
    ReminderStore.save(context, row("future", now + 120000, now + 600000))
    assertThrows(IllegalStateException::class.java) { ReminderStore.recover(context, now + 90000) }
    val rows = JSONArray(ReminderStore.list(context))
    assertFalse(rows.getJSONObject(0).getBoolean("delivered"))
    assertTrue(rows.getJSONObject(1).getBoolean("delivered"))
    assertEquals(1, notifications.allNotifications.size)
    assertEquals(now + 120000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
  }

  @Test @Config(shadows = [ThrowingAlarms::class])
  fun failedArmKeepsPreviousListAndAlarm() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("old", now + 120000, now + 600000))
    ThrowingAlarms.failNext = true
    assertThrows(IllegalStateException::class.java) { ReminderStore.save(context, row("new", now + 60000, now + 600000)) }
    assertEquals("old", JSONArray(ReminderStore.list(context)).getJSONObject(0).getString("id"))
    assertEquals(now + 120000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
  }

  @Test fun failedWriteKeepsPreviousListAndAlarm() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("old", now + 120000, now + 600000))
    val blocked = File(context.noBackupFilesDir, "programme-reminders.json.new")
    blocked.mkdirs()
    File(blocked, "block").writeText("block")
    assertThrows(Exception::class.java) { ReminderStore.save(context, row("new", now + 60000, now + 600000)) }
    assertEquals("old", JSONArray(ReminderStore.list(context)).getJSONObject(0).getString("id"))
    assertEquals(now + 120000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
  }

  @Test fun reconcileAfterCancelNeverResurrects() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("old", now + 60000, now + 600000))
    ReminderStore.cancel(context, "old")
    ReminderStore.reconcile(context, """[{"id":"old","status":"scheduled"}]""")
    assertEquals(0, JSONArray(ReminderStore.list(context)).length())
    assertEquals(0, alarm.scheduledAlarms.size)
  }

  @Test fun unreadableRowsArePreservedAndReportedWithoutBlockingValidRows() {
    val now = System.currentTimeMillis()
    val invalid = JSONObject(row("unknown", now + 60000, now + 600000)).put("status", "future-status")
    val file = File(context.noBackupFilesDir, "programme-reminders.json")
    file.writeText(JSONArray().put(42).put(invalid).put(JSONObject(row("valid", now + 60000, now + 600000))).toString())
    assertEquals(1, JSONArray(ReminderStore.list(context)).length())
    assertEquals(true, ReminderStore.permission(context)["readFailed"])
    ReminderStore.recover(context)
    assertEquals(1, alarm.scheduledAlarms.size)
    ReminderStore.cancel(context, "valid")
    val retained = JSONArray(file.readText())
    assertEquals(2, retained.length())
    assertEquals(42, retained.getInt(0))
    assertEquals(invalid.toString(), retained.getJSONObject(1).toString())
  }

  @Test fun nativeGuidePatchUpdatesEndTime() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 60000, now + 120000))
    ReminderStore.reconcile(context, """[{"id":"one","status":"scheduled","stop":${now + 240000}}]""")
    assertEquals(now + 240000, JSONArray(ReminderStore.list(context)).getJSONObject(0).getLong("stop"))
  }
  @Test fun recentsClearsWarmAndColdPendingTaps() {
    val taps = ReminderTaps()
    val warm = Intent().putExtra("reminder", "warm")
    assertEquals("warm", taps.accept(warm))
    val history = Intent().putExtra("reminder", "old").addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
    assertNull(taps.accept(history))
    assertNull(taps.take(Intent()))
    assertNull(taps.take(history))
    taps.accept(warm)
    assertNull(taps.take(Intent().addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)))
  }
  @Test fun idleRecoveryDoesNotCreateRewriteOrRearm() {
    val file = File(context.noBackupFilesDir, "programme-reminders.json")
    ReminderStore.recover(context)
    assertFalse(file.exists())
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 60000, now + 600000))
    file.setLastModified(1000)
    val scheduled = alarm.peekNextScheduledAlarm()
    ReminderStore.recover(context)
    assertSame(scheduled, alarm.peekNextScheduledAlarm())
    assertEquals(1000L, file.lastModified())
  }
  @Test fun unreadableRowsWithPastEndExpireWhileUnknownEndIsPreserved() {
    val file = File(context.noBackupFilesDir, "programme-reminders.json")
    file.writeText(JSONArray().put(JSONObject().put("stop", System.currentTimeMillis() - 1)).put(42).toString())
    ReminderStore.recover(context)
    assertEquals("[42]", file.readText())
  }
  @Test @Config(shadows = [ThrowingNotifications::class])
  fun failedPostArmsExactRetryNoLaterThanEnd() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 1000, now + 30000))
    assertThrows(IllegalStateException::class.java) { ReminderStore.recover(context, now + 2000) }
    assertEquals(now + 30000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
  }
  @Test fun recoveryBroadcastPostsOnceAndArmsNext() {
    val now = System.currentTimeMillis()
    val file = File(context.noBackupFilesDir, "programme-reminders.json")
    file.writeText(JSONArray().put(JSONObject(row("due", now - 1000, now + 600000)))
      .put(JSONObject(row("next", now + 120000, now + 600000))).toString())
    fun broadcast() {
      context.sendBroadcast(Intent(context, ReminderRecoveryReceiver::class.java).setAction(Intent.ACTION_TIME_CHANGED))
      shadowOf(android.os.Looper.getMainLooper()).idle()
      val deadline = System.nanoTime() + 5_000_000_000L
      while (!JSONArray(ReminderStore.list(context)).getJSONObject(0).getBoolean("delivered") && System.nanoTime() < deadline) Thread.yield()
      assertTrue(JSONArray(ReminderStore.list(context)).getJSONObject(0).getBoolean("delivered"))
    }
    broadcast()
    assertEquals(1, notifications.allNotifications.size)
    assertEquals(now + 120000, requireNotNull(alarm.peekNextScheduledAlarm()).triggerAtTime)
    context.getSystemService(NotificationManager::class.java).cancelAll()
    broadcast()
    ReminderStore.recover(context)
    assertEquals(0, notifications.allNotifications.size)
  }

  @Test @Config(shadows = [BlockingWriteNotifications::class])
  fun successfulPostWithFailedWriteIsNotRepeatedInProcess() {
    val now = System.currentTimeMillis()
    BlockingWriteNotifications.posts = 0
    ReminderStore.save(context, row("persistence", now + 1000, now + 600000))
    repeat(2) { assertThrows(Exception::class.java) { ReminderStore.recover(context, now + 2000) } }
    assertEquals(1, BlockingWriteNotifications.posts)
    File(context.noBackupFilesDir, "programme-reminders.json.new").deleteRecursively()
    ReminderStore.recover(context, now + 2000)
    assertTrue(JSONArray(ReminderStore.list(context)).getJSONObject(0).getBoolean("delivered"))
    assertEquals(1, BlockingWriteNotifications.posts)
  }
  @Test fun notificationsOffKeepsAlarmAndUndeliveredRowForLateRecovery() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("one", now + 1000, now + 600000))
    notifications.setNotificationsEnabled(false)
    ReminderStore.recover(context, now + 2000)
    assertFalse(JSONArray(ReminderStore.list(context)).getJSONObject(0).getBoolean("delivered"))
    assertEquals(1, alarm.scheduledAlarms.size)
    notifications.setNotificationsEnabled(true)
    ReminderStore.recover(context, now + 62000)
    assertEquals(1, notifications.allNotifications.size)
  }

  @Test fun lateRecoveryNamesElapsedMinutesAndPostsOnce() {
    val now = System.currentTimeMillis()
    ReminderStore.save(context, row("late", now + 1000, now + 600000))
    ReminderStore.recover(context, now + 181000)
    assertEquals(1, notifications.allNotifications.size)
    assertEquals("Started 3 min ago on Test channel", notifications.allNotifications.single().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    assertTrue(JSONArray(ReminderStore.list(context)).getJSONObject(0).getBoolean("delivered"))
    context.getSystemService(NotificationManager::class.java).cancelAll()
    ReminderStore.recover(context, now + 241000)
    assertEquals(0, notifications.allNotifications.size)
  }

  @Test fun invalidatedGuideRowsNeverPostAndProviderRemovalDropsItsRow() {
    val now = System.currentTimeMillis()
    for (id in listOf("changed", "missing", "removed")) ReminderStore.save(context, row(id, now + 1000, now + 600000))
    ReminderStore.reconcile(context, """[{"id":"changed","status":"changed","changedTitle":"Film"},{"id":"missing","status":"missing"},{"id":"removed","remove":true}]""")
    ReminderStore.recover(context, now + 121000)
    val rows = JSONArray(ReminderStore.list(context))
    assertEquals(2, rows.length())
    assertEquals("changed", rows.getJSONObject(0).getString("status"))
    assertEquals("Film", rows.getJSONObject(0).getString("changedTitle"))
    assertEquals("missing", rows.getJSONObject(1).getString("status"))
    assertFalse(rows.getJSONObject(0).getBoolean("delivered"))
    assertFalse(rows.getJSONObject(1).getBoolean("delivered"))
    assertEquals(0, notifications.allNotifications.size)
    assertEquals(0, alarm.scheduledAlarms.size)
  }

  @Test @Config(sdk = [35]) fun missingAccessChoosesItsSettingsAndReportsUnresolvablePages() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    val manager = context.getSystemService(NotificationManager::class.java)
    for ((kind, action) in listOf(
      "notifications" to android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS,
      "channel" to android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS,
      "exact" to android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
    )) {
      notifications.setNotificationsEnabled(kind != "notifications")
      val channel = manager.getNotificationChannel(ReminderStore.CHANNEL)
      channel.importance = if (kind == "channel") NotificationManager.IMPORTANCE_NONE else NotificationManager.IMPORTANCE_DEFAULT
      manager.createNotificationChannel(channel)
      ShadowAlarmManager.setCanScheduleExactAlarms(kind != "exact")
      assertEquals(kind, ReminderStore.permission(context)["missing"])
      assertEquals(false, ReminderStore.permission(context)["canOpen"])
      val intent = ReminderStore.setting(context, kind)
      assertEquals(action, intent.action)
      if (kind == "exact") assertEquals("package:${context.packageName}", intent.data.toString())
      else assertEquals(context.packageName, intent.getStringExtra(android.provider.Settings.EXTRA_APP_PACKAGE))
      if (kind == "channel") assertEquals(ReminderStore.CHANNEL, intent.getStringExtra(android.provider.Settings.EXTRA_CHANNEL_ID))
      val resolved = ResolveInfo().apply {
        activityInfo = ActivityInfo().apply { packageName = "settings"; name = "SettingsActivity"; applicationInfo = context.applicationInfo }
      }
      shadowOf(context.packageManager).addResolveInfoForIntent(intent, resolved)
      assertEquals(true, ReminderStore.permission(context)["canOpen"])
      shadowOf(context.packageManager).removeResolveInfosForIntent(intent, "settings")
      channel.importance = NotificationManager.IMPORTANCE_DEFAULT
      manager.createNotificationChannel(channel)
    }
  }

}
