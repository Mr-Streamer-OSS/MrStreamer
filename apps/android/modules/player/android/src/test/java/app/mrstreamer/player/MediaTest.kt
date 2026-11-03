package app.mrstreamer.player

import android.app.KeyguardManager
import android.app.Activity
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.test.utils.TestExoPlayerBuilder
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Player
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaTest {
  @Test fun sessionCannotReplaceMediaOrChangeSpeed() {
    val owner = PlayerHost.owner(RuntimeEnvironment.getApplication())
    try {
      owner.admit(Admission("session", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      val exposed = PlayerHost.session!!.player
      exposed.setMediaItem(MediaItem.fromUri("https://example.invalid/file"))
      assertEquals(0, exposed.mediaItemCount)
      exposed.setPlaybackSpeed(2f)
      assertEquals(1f, exposed.playbackParameters.speed)
    } finally { owner.stopAll() }
  }

  @Test fun previewHasNoSessionOrPipAndNormalPlaybackRestoresSession() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      owner.admit(Admission("normal", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      assertNotNull(PlayerHost.session)
      owner.admit(Admission("preview", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing"), preview = true))
      assertNull(PlayerHost.session)
      PlayerPip.watch(true)
      assertFalse(PlayerPip.enter())
      owner.admit(Admission("normal-again", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      assertNotNull(PlayerHost.session)
    } finally { owner.stopAll(); PlayerPip.watch(false); PlayerPip.detach(activity); activity.finish() }
  }

  @Test fun observationsDoNotRefreshControlsAndReplacementDoesNotAnnounceFinalStop() {
    val context: Context = RuntimeEnvironment.getApplication()
    val player = TestExoPlayerBuilder(context).build()
    val owner = PlayerOwner(player)
    val changes = mutableListOf<String?>()
    owner.changed = { changes.add(owner.attempt) }
    fun admit(id: String) = owner.admit(Admission(id, "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
    try {
      admit("one")
      changes.clear()
      owner.reconcile(); owner.reconcile()
      assertTrue(changes.isEmpty())
      admit("two")
      assertFalse(changes.contains(null))
      owner.stopAll()
      assertEquals(null, changes.last())
    } finally { player.release() }
  }

  @Test fun leavingWatchRequestsNotificationPermissionOnce() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      owner.admit(Admission("permission", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      PlayerPip.attach(activity)
      PlayerPip.watch(true); PlayerPip.watch(false)
      assertArrayEquals(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), shadowOf(activity).lastRequestedPermission.requestedPermissions)
      val first = shadowOf(activity).lastRequestedPermission
      PlayerPip.watch(true); PlayerPip.watch(false)
      assertSame(first, shadowOf(activity).lastRequestedPermission)
      assertNotNull(owner.attempt)
    } finally { PlayerPip.detach(activity); owner.stopAll(); activity.finish() }
  }

  class PipActivity : Activity() {
    var inPip = false
    override fun isInPictureInPictureMode() = inPip
  }

  @Test fun screenLockKeepsPlayingButDismissalAfterModeFlipStops() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    val keyguard = shadowOf(activity.getSystemService(KeyguardManager::class.java))
    try {
      PlayerPip.attach(activity)
      owner.admit(Admission("pip", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      activity.inPip = true; PlayerPip.mode(true)
      keyguard.setKeyguardLocked(true)
      PlayerPip.stopped(activity)
      assertEquals("pip", owner.attempt)
      keyguard.setKeyguardLocked(false)
      activity.inPip = false
      PlayerPip.mode(false)
      assertNull(owner.attempt)
      owner.admit(Admission("expand", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      activity.inPip = true; PlayerPip.mode(true)
      PlayerPip.stopped(activity)
      PlayerPip.started()
      activity.inPip = false; PlayerPip.mode(false)
      assertEquals("expand", owner.attempt)
      activity.inPip = true; PlayerPip.mode(true)
      activity.inPip = false; PlayerPip.mode(false)
      shadowOf(android.os.Looper.getMainLooper()).idle()
      PlayerPip.stopped(activity)
      assertNull(owner.attempt)
    } finally { PlayerPip.detach(activity); owner.stopAll(); activity.finish() }
  }

  @Test fun homeAndPipDoNotRequestNotifications() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      owner.admit(Admission("permission-entry", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      PlayerPip.watch(true)
      PlayerPip.home()
      PlayerPip.enter()
      assertNull(shadowOf(activity).lastRequestedPermission)
    } finally { PlayerPip.detach(activity); owner.stopAll(); PlayerPip.watch(false); activity.finish() }
  }

  @Test fun forgedPipBroadcastCannotControlPlayback() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      owner.admit(Admission("guessable", "https://example.invalid/video.mp4", emptyMap(), "progressive", "title", 0, HoldRef.Source("test")))
      val view = androidx.media3.ui.PlayerView(activity)
      owner.attach(view)
      owner.pauseCurrent()
      // The unauthenticated Pause broadcast must not resume paused playback.
      activity.sendBroadcast(android.content.Intent("app.mrstreamer.player.PAUSE").setPackage(activity.packageName).putExtra("attempt", "guessable"))
      shadowOf(android.os.Looper.getMainLooper()).idle()
      assertFalse(view.player!!.playWhenReady)
    } finally { PlayerPip.detach(activity); owner.stopAll(); activity.finish() }
  }

  @Test fun sessionCustomActionsRespectMode() {
    fun has(live: Boolean, next: Boolean, action: String) = PlayerHost.sessionCommands(live, next)
      .contains(androidx.media3.session.SessionCommand(action, android.os.Bundle.EMPTY))
    assertTrue(has(true, true, "close"))
    assertFalse(has(true, true, "back"))
    assertFalse(has(true, true, "next"))
    assertTrue(has(false, false, "back"))
    assertTrue(has(false, false, "forward"))
    assertFalse(has(false, false, "next"))
    assertTrue(has(false, true, "next"))
  }

  @Test fun unsupportedTrackNeverAppearsSelected() {
    val group = TrackGroup(Format.Builder().setSampleMimeType("audio/aac").setLanguage("nl").build())
    val tracks = Tracks(ImmutableList.of(Tracks.Group(group, false,
      intArrayOf(C.FORMAT_UNSUPPORTED_TYPE), booleanArrayOf(true))))
    val track = PlayerOwner.tracksOf(tracks).single()
    assertEquals("audio", track.type)
    assertEquals("nl", track.language)
    assertFalse(track.supported)
    assertFalse(track.selected)
  }
  @Test fun systemCommandsRespectModeAndSuppliedNext() {
    val live = PlayerHost.commands(true, true)
    assertTrue(live.contains(Player.COMMAND_STOP))
    assertTrue(live.contains(Player.COMMAND_PLAY_PAUSE))
    assertFalse(live.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertFalse(live.contains(Player.COMMAND_SEEK_TO_NEXT))
    val title = PlayerHost.commands(false, false)
    assertTrue(title.contains(Player.COMMAND_SEEK_BACK))
    assertTrue(title.contains(Player.COMMAND_SEEK_FORWARD))
    assertTrue(title.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertFalse(title.contains(Player.COMMAND_SEEK_TO_NEXT))
    assertTrue(PlayerHost.commands(false, true).contains(Player.COMMAND_SEEK_TO_NEXT))
    assertFalse(title.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    assertFalse(title.contains(Player.COMMAND_PREPARE))
    assertFalse(title.contains(Player.COMMAND_SET_SPEED_AND_PITCH))
  }
}
