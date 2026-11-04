package app.mrstreamer.reminders

import android.content.Intent
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemindersModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private var pendingTap: String? = null

  /** The notification tap that opened or resumed the app, handed to JS once. */
  private fun takeTap(): String? = synchronized(this) {
    val intent = appContext.currentActivity?.intent
    val history = intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
    val json = pendingTap ?: if (history) null else intent?.getStringExtra("reminder")
    pendingTap = null
    intent?.removeExtra("reminder")
    json
  }

  override fun definition() = ModuleDefinition {
    Name("ProgrammeReminders")
    Events("tap")
    OnNewIntent { intent ->
      if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return@OnNewIntent
      val json = intent.getStringExtra("reminder") ?: return@OnNewIntent
      synchronized(this@RemindersModule) { pendingTap = json }
      appContext.currentActivity?.intent = intent
      sendEvent("tap", mapOf("json" to json))
    }
    AsyncFunction("takeTap") { takeTap() }
    AsyncFunction("list") { ReminderStore.list(context) }
    AsyncFunction("permission") { ReminderStore.permission(context) }
    AsyncFunction("openSetting") { kind: String -> context.startActivity(ReminderStore.setting(context, kind)) }
    AsyncFunction("save") { json: String -> ReminderStore.save(context, json) }
    AsyncFunction("cancel") { id: String -> ReminderStore.cancel(context, id) }
    AsyncFunction("reconcile") { json: String -> ReminderStore.reconcile(context, json) }
    AsyncFunction("recover") { ReminderStore.recover(context) }
  }
}
