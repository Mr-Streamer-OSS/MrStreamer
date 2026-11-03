package app.mrstreamer.guide

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.io.ByteArrayOutputStream
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

fun guideTime(value: String?): Long? = try {
  val text = value?.trim() ?: ""
  val match = Regex("^([0-9]{8}(?:[0-9]{2}){0,3})(?:\\s*([+-][0-9]{2}:?[0-9]{2}|Z))?$").matchEntire(text)
  if (match == null) null else {
    val digits = match.groupValues[1].padEnd(14, '0')
    val zone = match.groupValues[2].ifEmpty { "Z" }
    val offset = if (zone == "Z") 0 else {
      val parts = zone.replace(":", "")
      val hours = parts.substring(1, 3).toInt(); val minutes = parts.substring(3, 5).toInt()
      require(hours <= 23 && minutes < 60)
      (hours * 60 + minutes) * 60 * if (parts[0] == '-') -1 else 1
    }
    LocalDateTime.parse(digits, DateTimeFormatter.ofPattern("uuuuMMddHHmmss").withResolverStyle(java.time.format.ResolverStyle.STRICT))
      .toInstant(ZoneOffset.UTC).toEpochMilli() - offset * 1000L
  }
} catch (_: Exception) { null }

/** Byte-level guard runs before XmlPullParser can allocate a token or resolve markup. */
fun preflight(file: File, job: GuideJob): Pair<Long, Long>? {
  var declarationRange: Pair<Long, Long>? = null
  var token = 0; var text = 0; var depth = 0; var element = 0
  var inTag = false; var quote = 0; var total = 0L
  var rootSeen = false; var external = false
  val tag = StringBuilder()
  file.inputStream().buffered().use { input ->
    while (true) {
      val b = input.read(); if (b < 0) break
      if (++total % 32768 == 0L) job.check()
      if (total > GuideBudget.PLAIN) throw GuideFailure("body")
      if (b == 0) throw GuideFailure("xml")
      if (depth >= 2 && ++element > GuideBudget.TOKEN) throw GuideFailure("element")
      if (!inTag) {
        if (b == 60) { inTag = true; token = 1; tag.setLength(0); quote = 0; text = 0 }
        else if (++text > GuideBudget.TOKEN) throw GuideFailure("element")
      } else {
        if (++token > GuideBudget.TOKEN) throw GuideFailure("element")
        tag.append(b.toChar())
        val comment = tag.startsWith("!--")
        val cdata = tag.startsWith("![CDATA[")
        if ((comment && tag.endsWith("-->")) || (cdata && tag.endsWith("]]>"))) { inTag = false; text = 0 }
        else if (comment || cdata) continue
        else if (quote != 0) { if (b == quote) quote = 0 }
        else if (b == 34 || b == 39) quote = b
        else if (b == 62) {
          val s = tag.toString()
          if (s.startsWith("?xml") && Regex("encoding\\s*=\\s*['\"](?!utf-8['\"])", RegexOption.IGNORE_CASE).containsMatchIn(s)) throw GuideFailure("xml")
          if (s.startsWith("!")) {
            val literal = "(?:\"[^\"]+\"|'[^']+')"
            val declaration = Regex("!DOCTYPE[\\t\\r\\n ]+tv[\\t\\r\\n ]+(?:SYSTEM[\\t\\r\\n ]+$literal|PUBLIC[\\t\\r\\n ]+$literal[\\t\\r\\n ]+$literal)[\\t\\r\\n ]*>")
            if (rootSeen || external || depth != 0 || !declaration.matches(s)) throw GuideFailure("xml")
            external = true
            declarationRange = (total - token) to total
          }
          if (!s.startsWith("?") && !s.startsWith("!")) {
            rootSeen = true
            if (s.startsWith("/")) depth--
            else if (!s.endsWith("/>")) { depth++; if (depth == 2) element = token }
            if (depth > GuideBudget.DEPTH) throw GuideFailure("depth")
            if (depth < 0) throw GuideFailure("xml")
          }
          inTag = false
        }
      }
    }
  }
  job.check()
  if (inTag || depth != 0) throw GuideFailure("xml")
  return declarationRange
}

private fun whole(value: String) = Regex("(?<![\\p{L}\\p{N}._~\\-])${Regex.escape(value)}(?![\\p{L}\\p{N}._~\\-])")
private fun unescaped(text: String): String {
  val bytes = text.toByteArray(); val out = ByteArrayOutputStream(); var at = 0
  while (at < bytes.size) {
    val high = if (at + 2 < bytes.size) bytes[at + 1].toInt().toChar().digitToIntOrNull(16) else null
    val low = if (at + 2 < bytes.size) bytes[at + 2].toInt().toChar().digitToIntOrNull(16) else null
    if (bytes[at] == 37.toByte() && high != null && low != null) { out.write(high * 16 + low); at += 3 }
    else { out.write(bytes[at].toInt()); at++ }
  }
  return out.toByteArray().toString(Charsets.UTF_8)
}
private fun clipped(text: String, limit: Int) = text.take(text.offsetByCodePoints(0, minOf(limit, text.codePointCount(0, text.length))))
private fun secret(text: String, login: List<String>, uncertain: List<Regex>): Boolean {
  var forms = setOf(text)
  repeat(5) {
    if (forms.any { value -> login.any { value.contains(it) } || uncertain.any { it.containsMatchIn(value) } }) return true
    val next = forms.flatMap { value -> listOf(value, unescaped(value), unescaped(value.replace("+", " "))) }.toSet()
    if (next == forms) return false
    forms = next
  }
  return true
}

fun readXml(file: File, job: GuideJob, login: List<String>, uncertain: List<String>, insert: (String, Long, Long?, String, String?) -> Unit) {
  val declaration = preflight(file, job)
  val passwords = login.drop(1).filter { it.isNotEmpty() }
  val patterns = uncertain.filter { it.isNotEmpty() }.map(::whole)
  val parser = Xml.newPullParser()
  parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
  parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
  val stack = mutableListOf<String>(); val ids = mutableSetOf<String>()
  var rows = 0; var opened = false; var closed = false
  var channel = ""; var start: Long? = null; var stop: Long? = null
  var title: String? = null; var description: String? = null
  val text = StringBuilder()
  try {
    file.inputStream().buffered().use { input ->
      // Strip only the byte range validated in the prolog; preserve comments and CDATA.
      val filtered = object : java.io.InputStream() {
        var position = 0L
        init {
          input.mark(3)
          if (input.read() == 0xEF && input.read() == 0xBB && input.read() == 0xBF) position = 3 else input.reset()
        }
        override fun read(): Int {
          val one = ByteArray(1)
          return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 255
        }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
          if (length == 0) return 0
          if (declaration != null && position == declaration.first) {
            while (position < declaration.second) {
              val skipped = input.skip(declaration.second - position)
              if (skipped == 0L) throw GuideFailure("xml")
              position += skipped
            }
          }
          val count = if (declaration != null && position < declaration.first)
            minOf(length.toLong(), declaration.first - position).toInt() else length
          val n = input.read(buffer, offset, count)
          if (n > 0) position += n
          return n
        }
      }
      parser.setInput(filtered.reader(Charsets.UTF_8))
      while (true) {
        job.check()
        when (parser.nextToken()) {
          XmlPullParser.END_DOCUMENT -> break
          XmlPullParser.DOCDECL -> throw GuideFailure("xml")
          XmlPullParser.ENTITY_REF -> {
            if (parser.text == null) throw GuideFailure("xml")
            text.append(parser.text)
          }
          XmlPullParser.START_TAG -> {
            val name = parser.name
            if (stack.isEmpty()) { if (name != "tv" || opened) throw GuideFailure("xml"); opened = true }
            if (name == "programme") {
              if (stack != listOf("tv")) throw GuideFailure("xml")
              if (++rows > GuideBudget.ROWS) throw GuideFailure("rows")
              channel = parser.getAttributeValue(null, "channel") ?: ""
              start = guideTime(parser.getAttributeValue(null, "start")); stop = guideTime(parser.getAttributeValue(null, "stop"))
              title = null; description = null
            }
            val id = if (name == "channel") parser.getAttributeValue(null, "id") else if (name == "programme") channel else null
            if (id != null && id.isNotEmpty() && id.toByteArray().size <= 512) {
              ids.add(id); if (ids.size > GuideBudget.CHANNELS) throw GuideFailure("rows")
            }
            stack.add(name); text.setLength(0)
          }
          XmlPullParser.TEXT, XmlPullParser.CDSECT -> text.append(parser.text)
          XmlPullParser.END_TAG -> {
            val value = text.toString().trim().replace(Regex("\\s+"), " ")
            if (stack == listOf("tv", "programme", "title") && title == null) title = clipped(value, 300)
            if (stack == listOf("tv", "programme", "desc") && description == null) description = clipped(value, 2000)
            val s = start; val t = title
            if (parser.name == "programme" && channel.isNotEmpty() && channel.toByteArray().size <= 512 && s != null && !t.isNullOrEmpty() && (stop == null || stop!! - s >= 60000)) {
              if (listOf(channel, t, description ?: "").any { secret(it, passwords, patterns) }) throw GuideFailure("xml")
              insert(channel, s, stop, t, description)
            }
            if (stack == listOf("tv")) closed = true
            stack.removeAt(stack.lastIndex); text.setLength(0)
          }
        }
        if (text.length > GuideBudget.TOKEN) throw GuideFailure("element")
      }
    }
  } catch (e: GuideFailure) { throw e }
  catch (_: Exception) { throw GuideFailure("xml") }
  if (!opened || !closed) throw GuideFailure("xml")
  if (rows == 0) throw GuideFailure("empty")
}
