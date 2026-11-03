package app.mrstreamer.player

import androidx.core.content.ContextCompat
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.app.AppOpsManager
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
  private var stopped = true
  private var leavingPip = false
  private val token = java.util.UUID.randomUUID().toString()
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.getStringExtra("token") != token) return
      val owner = PlayerHost.existing()?.takeUnless { it.preview } ?: return
      if (intent.getStringExtra("attempt") != owner.attempt) return
      when (intent.action) {
        "app.mrstreamer.player.PAUSE" -> if (owner.isPlaying) owner.pauseCurrent() else owner.resumeCurrent()
        "app.mrstreamer.player.BACK" -> owner.jump(-10_000)
        "app.mrstreamer.player.FORWARD" -> owner.jump(10_000)
      }
    }
  }
  fun attach(host: Activity) {
    activity = WeakReference(host)
    pip = host.isInPictureInPictureMode
    val filter = IntentFilter().apply {
      addAction("app.mrstreamer.player.PAUSE"); addAction("app.mrstreamer.player.BACK"); addAction("app.mrstreamer.player.FORWARD")
    }
    ContextCompat.registerReceiver(host, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    PlayerHost.existing()?.takeUnless { it.preview }?.reconcile()
    refresh()
  }
  fun detach(host: Activity) {
    host.unregisterReceiver(receiver)
    if (activity.get() === host) { activity.clear(); stopped = true; pip = false }
  }
  fun watch(enabled: Boolean) { if (watch && !enabled) requestNotifications(); watch = enabled; refresh() }
  fun requestNotifications() {
    val host = activity.get() ?: return
    if (Build.VERSION.SDK_INT >= 33 && PlayerHost.existing()?.takeUnless { it.preview }?.attempt != null &&
      host.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      val preferences = host.getSharedPreferences("player", Context.MODE_PRIVATE)
      if (preferences.getBoolean("notificationsRequested", false)) return
      try {
        host.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 501)
        // Record only an initiated request, so a thrown request remains retryable.
        preferences.edit().putBoolean("notificationsRequested", true).commit()
      } catch (_: IllegalStateException) { }
        catch (_: SecurityException) { }
    }
  }
  fun enter(): Boolean {
    val host = activity.get() ?: return false
    if (!supported(host) || !watch || PlayerHost.existing()?.takeUnless { it.preview }?.attempt == null) return false
    return try { host.enterPictureInPictureMode(params(host)) } catch (_: IllegalStateException) { false }
  }
  fun home() {
    if (Build.VERSION.SDK_INT < 31 && watch && PlayerHost.existing()?.takeUnless { it.preview }?.isPlaying == true) enter()
  }
  fun mode(inPip: Boolean) {
    val wasPip = pip
    pip = inPip
    if (inPip) PlayerHost.existing()?.takeIf { it.preview }?.stopAll()
    if (wasPip && !inPip) {
      leavingPip = true
      // Expansion starts the Activity; dismissal leaves it stopped. Let lifecycle callbacks settle.
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        val current = activity.get()
        if (leavingPip && current != null && dismissed(stopped, false, current.isChangingConfigurations, locked(current))) PlayerHost.existing()?.takeUnless { it.preview }?.stopAll()
      }
    }
    val host = activity.get()
    if (wasPip && !inPip && host != null && dismissed(stopped, false, host.isChangingConfigurations, locked(host))) PlayerHost.existing()?.takeUnless { it.preview }?.stopAll()
    PlayerHost.existing()?.takeUnless { it.preview }?.let { owner -> owner.attempt?.let { owner.events?.media(it, inPip) } }
  }
  fun canPreview(): Boolean = activity.get()?.let { !watch && !stopped && !pip && !it.isInPictureInPictureMode } == true
  fun started() { stopped = false; leavingPip = false }
  fun stopped(host: Activity) {
    stopped = true
    PlayerHost.existing()?.takeIf { it.preview }?.stopAll()
    if ((pip || leavingPip) && dismissed(true, host.isInPictureInPictureMode, host.isChangingConfigurations, locked(host))) {
      PlayerHost.existing()?.takeUnless { it.preview }?.stopAll()
      mode(false)
    }
  }
  private fun dismissed(stopped: Boolean, inPip: Boolean, changing: Boolean, locked: Boolean) = stopped && !inPip && !changing && !locked
  private fun locked(host: Activity) = host.getSystemService(KeyguardManager::class.java).isKeyguardLocked
  fun reconcile() { activity.get()?.let { mode(it.isInPictureInPictureMode) } }
  fun supported(): Boolean = activity.get()?.let(::supported) ?: false
  private fun supported(host: Activity): Boolean = host.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE) &&
    host.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, host.applicationInfo.uid, host.packageName) == AppOpsManager.MODE_ALLOWED
  fun refresh() { activity.get()?.let { if (supported(it)) it.setPictureInPictureParams(params(it)) } }
  private fun params(host: Activity): PictureInPictureParams {
    val owner = PlayerHost.existing()?.takeUnless { it.preview }
    fun action(name: String, label: String, icon: Int, request: Int): RemoteAction {
      val intent = Intent("app.mrstreamer.player.$name").setPackage(host.packageName).putExtra("attempt", owner?.attempt).putExtra("token", token)
      return RemoteAction(Icon.createWithResource(host, icon), label, label,
        PendingIntent.getBroadcast(host, request, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    val actions = buildList {
      if (owner?.live == false) add(action("BACK", host.getString(app.mrstreamer.playback.R.string.player_back), android.R.drawable.ic_media_rew, 1))
      add(action("PAUSE", host.getString(if (owner?.isPlaying == true) app.mrstreamer.playback.R.string.player_pause else app.mrstreamer.playback.R.string.player_play), if (owner?.isPlaying == true) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, 2))
      if (owner?.live == false) add(action("FORWARD", host.getString(app.mrstreamer.playback.R.string.player_forward), android.R.drawable.ic_media_ff, 3))
    }
    return PictureInPictureParams.Builder().setActions(actions).apply {
      if (Build.VERSION.SDK_INT >= 31) setAutoEnterEnabled(watch && owner?.isPlaying == true)
    }.build()
  }
}
