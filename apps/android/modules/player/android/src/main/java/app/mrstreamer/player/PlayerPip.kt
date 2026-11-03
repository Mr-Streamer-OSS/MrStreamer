package app.mrstreamer.player

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.os.Build
import androidx.media3.common.util.UnstableApi
import java.lang.ref.WeakReference

/** Activity hooks keep PiP attached to the same owner and the same Watch. */
@UnstableApi
object PlayerPip {
  private var activity = WeakReference<Activity>(null)
  private var watch = false
  private var pip = false
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val owner = PlayerHost.existing() ?: return
      if (intent.getStringExtra("attempt") != owner.attempt) return
      when (intent.action) {
        "app.mrstreamer.player.PAUSE" -> owner.pauseCurrent()
        "app.mrstreamer.player.BACK" -> owner.jump(-10_000)
        "app.mrstreamer.player.FORWARD" -> owner.jump(10_000)
      }
    }
  }
  fun attach(host: Activity) {
    activity = WeakReference(host)
    val filter = IntentFilter().apply {
      addAction("app.mrstreamer.player.PAUSE"); addAction("app.mrstreamer.player.BACK"); addAction("app.mrstreamer.player.FORWARD")
    }
    if (Build.VERSION.SDK_INT >= 33) host.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else host.registerReceiver(receiver, filter)
    PlayerHost.existing()?.reconcile()
    refresh()
  }
  fun detach(host: Activity) {
    host.unregisterReceiver(receiver)
    if (activity.get() === host) activity.clear()
  }
  fun watch(enabled: Boolean) { watch = enabled; refresh() }
  fun enter(): Boolean {
    val host = activity.get() ?: return false
    if (!supported(host) || !watch || PlayerHost.existing()?.attempt == null) return false
    return try { host.enterPictureInPictureMode(params(host)) } catch (_: IllegalStateException) { false }
  }
  fun home() { if (watch && PlayerHost.existing()?.isPlaying == true) enter() }
  fun mode(inPip: Boolean) {
    pip = inPip
    PlayerHost.existing()?.let { owner -> owner.attempt?.let { owner.events?.media(it, inPip) } }
  }
  fun stopped(host: Activity) {
    if (host.isInPictureInPictureMode && !host.isChangingConfigurations) {
      PlayerHost.existing()?.stopAll()
      mode(false)
    }
  }
  fun reconcile() { activity.get()?.let { mode(it.isInPictureInPictureMode) } }
  private fun supported(host: Activity) = host.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)
  fun refresh() { activity.get()?.let { if (supported(it)) it.setPictureInPictureParams(params(it)) } }
  private fun params(host: Activity): PictureInPictureParams {
    val owner = PlayerHost.existing()
    fun action(name: String, label: String, icon: Int, request: Int): RemoteAction {
      val intent = Intent("app.mrstreamer.player.$name").setPackage(host.packageName).putExtra("attempt", owner?.attempt)
      return RemoteAction(Icon.createWithResource(host, icon), label, label,
        PendingIntent.getBroadcast(host, request, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    val actions = buildList {
      if (owner?.live == false) add(action("BACK", "Back 10", android.R.drawable.ic_media_rew, 1))
      add(action("PAUSE", "Pause", android.R.drawable.ic_media_pause, 2))
      if (owner?.live == false) add(action("FORWARD", "Forward 10", android.R.drawable.ic_media_ff, 3))
    }
    return PictureInPictureParams.Builder().setActions(actions).apply {
      if (Build.VERSION.SDK_INT >= 31) setAutoEnterEnabled(watch && owner?.isPlaying == true)
    }.build()
  }
}
