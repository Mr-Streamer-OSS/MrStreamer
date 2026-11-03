package app.mrstreamer.player

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
