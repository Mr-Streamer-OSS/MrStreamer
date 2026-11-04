package app.mrstreamer.reminders

import android.content.Intent
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemindersModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val taps = ReminderTaps()

  override fun definition() = ModuleDefinition {
    Name("ProgrammeReminders")
    Events("tap")
    OnNewIntent { intent ->
      appContext.currentActivity?.intent = intent
      val json = taps.accept(intent) ?: return@OnNewIntent
      sendEvent("tap", mapOf("json" to json))
    }
    AsyncFunction("takeTap") { taps.take(appContext.currentActivity?.intent) }
    AsyncFunction("list") { ReminderStore.list(context) }
    AsyncFunction("permission") { ReminderStore.permission(context) }
    AsyncFunction("openSetting") { kind: String -> context.startActivity(ReminderStore.setting(context, kind)) }
    AsyncFunction("save") { json: String -> ReminderStore.save(context, json) }
    AsyncFunction("cancel") { id: String -> ReminderStore.cancel(context, id) }
    AsyncFunction("reconcile") { json: String -> ReminderStore.reconcile(context, json) }
    AsyncFunction("recover") { ReminderStore.recover(context) }
  }
}

/** Cold and warm notification extras are consumed once; Recents clears any queued tap. */
internal class ReminderTaps {
  private var pendingTap: String? = null
  @Synchronized fun accept(intent: Intent): String? {
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
      pendingTap = null
      intent.removeExtra("reminder")
      return null
    }
    return intent.getStringExtra("reminder")?.also { pendingTap = it }
  }
  @Synchronized fun take(intent: Intent?): String? {
    val history = intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
    val json = if (history) null else pendingTap ?: intent?.getStringExtra("reminder")
    pendingTap = null
    intent?.removeExtra("reminder")
    return json
  }
}
