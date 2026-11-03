package app.mrstreamer.guide

import android.content.Context
import android.util.AtomicFile
import org.robolectric.RuntimeEnvironment
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.zip.GZIPOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GuideTest {
  private fun fixture(work: (File) -> Unit) {
    val context = RuntimeEnvironment.getApplication()
    val root = File(context.cacheDir, "guide-test-${java.util.UUID.randomUUID()}")
    root.mkdirs()
    org.robolectric.shadows.ShadowStatFs.registerStats(root.path, 1000000, 1000000, 1000000)
    try { work(root) } finally { root.deleteRecursively() }
  }
  private fun refused(code: String, work: () -> Unit) {
    try { work(); fail("Expected refusal $code") } catch (e: GuideFailure) { assertEquals(code, e.code) }
  }
  @Test fun hostileXmlAndBounds() = fixture { root ->
    val file = File(root, "guide.xml"); val job = GuideJob("lease")
    for (xml in listOf("<!DOCTYPE tv SYSTEM 'file:///forbidden'><tv/>", "<!DOCTYPE tv [<!ENTITY a 'boom'>]><tv>&a;</tv>")) {
      file.writeText(xml); refused("xml") { readXml(file, job, emptyList(), emptyList()) { _, _, _, _, _ -> fail() } }
    }
    file.writeText("<tv><programme>${"x".repeat(GuideBudget.TOKEN + 1)}</programme></tv>")
    refused("element") { preflight(file, job) }
    file.writeText("<tv>" + "<a>".repeat(17) + "</a>".repeat(17) + "</tv>")
    refused("depth") { preflight(file, job) }
    file.writeText("<tv><programme channel='news' start='20261103120000 +0000'><title>encoded%2Dsecret</title></programme></tv>")
    refused("xml") { readXml(file, job, listOf("", "encoded-secret"), emptyList()) { _, _, _, _, _ -> fail() } }
  }
  @Test fun gzipAndCancellationAreBounded() = fixture { root ->
    val disk = GuideDisk(root); val job = GuideJob("lease")
    val packed = File(root, "packed"); val plain = File(root, "plain")
    packed.outputStream().use { raw -> GZIPOutputStream(raw).use { it.write("<tv/>".toByteArray()) } }
    disk.unpack(packed, plain, job); assertEquals("<tv/>", plain.readText())
    packed.writeBytes(byteArrayOf(31, -117, 0, 0)); refused("gzip") { disk.unpack(packed, plain, job) }
    refused("body") { disk.copy("oversized".byteInputStream(), plain, 3, job) }
    job.cancel(); refused("cancelled") { disk.unpack(packed, plain, job) }
  }
  @Test fun immutableIndexPages() = fixture { root ->
    val job = GuideJob("lease"); val disk = GuideDisk(root); val xml = File(root, "guide.xml")
    val from = guideTime("20261103000000 +0000")!!
    xml.writeText("<tv><!-- valid comment -->" + (0..139).joinToString("") { n ->
      val start = java.time.Instant.ofEpochMilli(from + n * 60000).atOffset(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.ofPattern("uuuuMMddHHmmss Z"))
      "<programme channel='news' start='$start'><title>News $n</title><desc>Details</desc></programme>"
    } + "</tv>")
    val db = File(root, "guide.db")
    GuideIndex(db, job, disk, true).use { it.ingest(xml, emptyList(), emptyList(), from, from, from + 86400000) }
    GuideIndex(db, job, disk).use { index ->
      val page = index.query(listOf("news"), from, "day", from, from + 86400000, -1)
      assertEquals(128, (page["rows"] as List<*>).size); assertEquals(true, page["more"])
      val next = index.query(listOf("news"), from, "day", from, from + 86400000, from + 127 * 60000)
      assertEquals(11, (next["rows"] as List<*>).size); assertEquals(false, next["more"])
    }
  }
  @Test fun revokedAndInterruptedGenerationsCannotReplaceLastGood() = fixture { root ->
    val owner = GuideOwner(root)
    val activation = owner.attach("source", 1); val lease = activation["lease"] as String
    assertTrue(owner.begin(lease, "ingest")); owner.revoke("source")
    assertEquals("changed", owner.publish(lease, "ingest", "missing")["kind"])
    val folder = root.listFiles()!!.single()
    val id = java.util.UUID.randomUUID().toString()
    File(folder, "$id.db").writeText("last good")
    val pointer = AtomicFile(File(folder, "current.json"))
    pointer.startWrite().also { it.write("{\"id\":\"$id\",\"fetchedAt\":1,\"until\":999}".toByteArray()); pointer.finishWrite(it) }
    val interrupted = pointer.startWrite(); interrupted.write("incomplete".toByteArray()); interrupted.close()
    File(folder, "orphan.db").writeText("unpublished")
    val restored = GuideOwner(root).attach("source", 2)
    assertEquals(id, (restored["generation"] as Map<*, *>)["id"])
    assertFalse(File(folder, "orphan.db").exists()); assertEquals("last good", File(folder, "$id.db").readText())
  }
}
