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
  @Test fun invalidProviderHeadersAreHttpFailures() = fixture { root ->
    val owner = GuideOwner(root)
    val lease = owner.attach("source", 1)["lease"] as String
    for ((index, headers) in listOf(mapOf("bad\nname" to "value"), mapOf("X-Guide" to "bad\rvalue")).withIndex()) {
      val job = "invalid-header-$index"
      assertTrue(owner.begin(lease, job))
      val answer = owner.prepare(lease, job, "http://127.0.0.1:1/guide", headers, emptyList(), emptyList(), 0, 0, 86400000).get(20, java.util.concurrent.TimeUnit.SECONDS)
      assertEquals("failed", answer["kind"])
      assertEquals("http", answer["error"])
      owner.cancel(job)
    }
  }
  @Test fun hostileXmlAndBounds() = fixture { root ->
    val file = File(root, "guide.xml"); val job = GuideJob("lease")
    for (xml in listOf("<!DOCTYPE tv [<!ENTITY a 'boom'>]><tv>&a;</tv>")) {
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
  private val xml = "<tv><programme channel='BBCOne.uk' start='20261103120000 +0000' stop='20261103130000 +0000'><title>News</title></programme></tv>"
  private fun prepared(owner: GuideOwner, lease: String, job: String, root: File): String {
    // Serve a real local XML file through the public HTTP ingestion path.
    val source = File(root, "fixture.xml").apply { writeText(xml) }
    val server = java.net.ServerSocket(0)
    val thread = Thread {
      server.accept().use { socket ->
        val reader = socket.getInputStream().bufferedReader()
        while (!reader.readLine().isNullOrEmpty()) { }
        val bytes = source.readBytes()
        socket.getOutputStream().apply {
          write("HTTP/1.1 200 OK\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(bytes); flush()
        }
      }
    }.apply { start() }
    try {
      assertTrue(owner.begin(lease, job))
      val at = guideTime("20261103120000 +0000")!!
      val answer = owner.prepare(lease, job, "http://127.0.0.1:${server.localPort}", emptyMap(), emptyList(), emptyList(), at, at - 86400000, at + 86400000).get(20, java.util.concurrent.TimeUnit.SECONDS)
      assertEquals("ok", answer["kind"])
      return (answer["value"] as Map<*, *>)["id"] as String
    } finally { server.close(); thread.join(2000); source.delete() }
  }
  @Test fun externalHeadersAndBomAreAcceptedWithoutResolvingIdentifiers() = fixture { root ->
    for (header in listOf("<!DOCTYPE tv SYSTEM 'file:///forbidden'>", "<!DOCTYPE tv PUBLIC 'xmltv' 'https://invalid.test/xmltv.dtd'>", "\uFEFF")) {
      val file = File(root, "guide.xml").apply { writeText(header + xml) }
      var count = 0
      readXml(file, GuideJob("lease"), emptyList(), emptyList()) { _, _, _, _, _ -> count++ }
      assertEquals(1, count)
    }
    for (header in listOf("<!DOCTYPE tv [<!ENTITY x 'secret'>]>", "<!DOCTYPE other SYSTEM 'x'>", "<!DOCTYPE tv SYSTEM 'x'><!DOCTYPE tv SYSTEM 'y'>")) {
      val file = File(root, "guide.xml").apply { writeText(header + xml) }
      refused("xml") { readXml(file, GuideJob("lease"), emptyList(), emptyList()) { _, _, _, _, _ -> fail() } }
    }
  }
  @Test fun xmltvDatePrecisionAndOffsetsAreStrict() {
    val expected = guideTime("20261103000000 +0000")
    for (value in listOf("20261103", "2026110300", "202611030000", "20261103000000", "202611030100+0100", "202611030100 +01:00", "202611030000Z")) assertEquals(value, expected, guideTime(value))
    for (value in listOf("20260230", "202611032400", "202611030000 +1260", "202611030")) assertNull(value, guideTime(value))
  }
  @Test fun utf8IdsAndWholeSecrets() = fixture { root ->
    val file = File(root, "guide.xml")
    for (id in listOf("BBCOne.uk", "x".repeat(200), "界".repeat(170))) {
      file.writeText(xml.replace("BBCOne.uk", id)); var count = 0
      readXml(file, GuideJob("lease"), listOf("uk"), listOf("uk")) { channel, _, _, _, _ -> assertEquals(id, channel); count++ }
      assertEquals(1, count)
    }
    file.writeText(xml.replace("News", "admin sport 2026"))
    var accepted = 0
    readXml(file, GuideJob("lease"), listOf("admin"), emptyList()) { _, _, _, _, _ -> accepted++ }
    assertEquals(1, accepted)
    file.writeText(xml.replace("News", "a secret value"))
    refused("xml") { readXml(file, GuideJob("lease"), listOf("name", "secret"), emptyList()) { _, _, _, _, _ -> } }
    file.writeText(xml.replace("News", "%73%65%63%72%65%74%oops"))
    refused("xml") { readXml(file, GuideJob("lease"), listOf("name", "secret"), emptyList()) { _, _, _, _, _ -> fail() } }
  }
  @Test fun pastDayAndLastProgrammeStillRead() = fixture { root ->
    val at = guideTime("20261103120000 +0000")!!
    val file = File(root, "guide.xml").apply { writeText(xml) }
    val db = File(root, "guide.db"); val disk = GuideDisk(root); val job = GuideJob("lease")
    GuideIndex(db, job, disk, true).use { it.ingest(file, emptyList(), emptyList(), at, at - 86400000, at + 86400000) }
    GuideIndex(db, job, disk).use {
      assertEquals(1, (it.query(listOf("BBCOne.uk"), at + 86400000, "day", at, at + 86400000, -1)["rows"] as List<*>).size)
      assertEquals(1, (it.query(listOf("BBCOne.uk"), at + 86400000, "detail", 0, 0, at)["rows"] as List<*>).size)
      assertNull(it.query(listOf("BBCOne.uk"), at + 86400000, "listing", 0, 0, -1)["guideId"])
    }
  }
  @Test fun repeatedPublicationsRetireOldDatabasesAndRevocationKeepsLastGood() = fixture { root ->
    val owner = GuideOwner(root); val lease = owner.attach("source", 1)["lease"] as String
    var good = ""
    repeat(4) { n ->
      good = prepared(owner, lease, "ingest$n", root)
      assertEquals("ok", owner.publish(lease, "ingest$n", good)["kind"])
      owner.cancel("ingest$n")
      assertEquals(1, root.walkTopDown().count { it.extension == "db" })
    }
    val candidate = prepared(owner, lease, "revoked", root)
    owner.revoke("source")
    assertEquals("changed", owner.publish(lease, "revoked", candidate)["kind"])
    assertEquals(good, (owner.attach("source", 2)["generation"] as Map<*, *>)["id"])
    val folder = root.listFiles()!!.single { it.isDirectory }
    assertEquals(good, org.json.JSONObject(File(folder, "current.json").readText()).getString("id"))
    owner.cancel("revoked")
  }
  @Test fun prefixRetentionIsSelectiveAndDamagedReceiptsAreIsolated() = fixture { root ->
    val owner = GuideOwner(root)
    owner.attach("xtream:removed", 1); owner.attach("custom:kept", 1); owner.attach("xtream:live", 1)
    owner.restore(listOf("xtream:live"), listOf("custom:"))
    assertEquals(2, root.listFiles()!!.count { it.isDirectory })
    val broken = root.listFiles()!!.first { File(it, "owner").readText() == "custom:kept" }
    File(broken, "current.json").writeText("damaged")
    val restored = GuideOwner(root).restore(listOf("xtream:live", "custom:kept"), emptyList())
    assertEquals(listOf("xtream:live", "custom:kept"), restored.map { it["subscriptionId"] })
    val activation = restored.last()["activation"] as Map<*, *>
    assertNull(activation["generation"]); assertEquals("disk", activation["error"])
    assertEquals("damaged", File(broken, "current.json").readText())
    val recovery = GuideOwner(root)
    val lease = recovery.attach("custom:kept", 2)["lease"] as String
    val candidate = prepared(recovery, lease, "repair", root)
    assertEquals("ok", recovery.publish(lease, "repair", candidate)["kind"])
  }
  @Test fun revokedAndInterruptedGenerationsCannotReplaceLastGood() = fixture { root ->
    val owner = GuideOwner(root)
    owner.attach("source", 1)
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
  @Test fun cdataAndCommentsPreserveDoctypeText() = fixture { root ->
    val file = File(root, "guide.xml").apply {
      writeText("<!DOCTYPE tv SYSTEM 'unused'>" + xml.replace("News", "<![CDATA[News <!DOCTYPE literal ]]>"))
    }
    var title = ""
    readXml(file, GuideJob("lease"), emptyList(), emptyList()) { _, _, _, value, _ -> title = value }
    assertEquals("News <!DOCTYPE literal", title)
    file.writeText(xml.replace("News", "<!-- <!DOCTYPE literal -->News"))
    readXml(file, GuideJob("lease"), emptyList(), emptyList()) { _, _, _, value, _ -> title = value }
    assertEquals("News", title)
  }
  @Test fun heldReadersRetainDatabaseUntilCloseAndRefuseStaleAnswers() = fixture { root ->
    val owner = GuideOwner(root); val lease = owner.attach("source", 1)["lease"] as String
    val first = prepared(owner, lease, "first", root)
    assertEquals("ok", owner.publish(lease, "first", first)["kind"])
    val second = prepared(owner, lease, "second", root)
    val entered = java.util.concurrent.CountDownLatch(1)
    val release = java.util.concurrent.CountDownLatch(1)
    assertTrue(owner.begin(lease, "read"))
    val read = owner.read(lease, first, "read") { entered.countDown(); release.await(5, java.util.concurrent.TimeUnit.SECONDS); mapOf("rows" to emptyList<Any>()) }
    try {
      assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
      assertEquals("ok", owner.publish(lease, "second", second)["kind"])
      assertTrue(root.walkTopDown().any { it.name == "$first.db" })
    } finally { release.countDown() }
    assertEquals("changed", read.get(5, java.util.concurrent.TimeUnit.SECONDS)["kind"])
    assertFalse(root.walkTopDown().any { it.name == "$first.db" })
  }
  @Test fun secondPassDatabaseCeilingIsBodyNotDisk() = fixture { root ->
    val file = File(root, "guide.xml")
    val at = guideTime("20261103120000 +0000")!!
    file.writeText("<tv>" + (1..100).joinToString("") { n -> xml.removePrefix("<tv>").removeSuffix("</tv>").replace("BBCOne.uk", "channel$n").replace("</title>", "</title><desc>${"x".repeat(2000)}</desc>") } + "</tv>")
    // Raw rows fit; copying those rows into the serving table exceeds this database ceiling.
    refused("body") {
      GuideIndex(File(root, "small.db"), GuideJob("lease"), GuideDisk(root), true, 150 * 4096L).use {
        it.ingest(file, emptyList(), emptyList(), at, at - 86400000, at + 86400000)
      }
    }
  }

}
