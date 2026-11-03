package app.mrstreamer.guide

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.net.URLDecoder
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

fun guideTime(value: String?): Long? = try {
  val text = value?.trim() ?: ""
  val match = Regex("^(\\d{14})(?:\\s+([+-]\\d{4}|Z))?$").matchEntire(text)
  if (match == null) null else {
    val zone = match.groupValues[2].ifEmpty { "+0000" }
    LocalDateTime.parse(match.groupValues[1], DateTimeFormatter.ofPattern("uuuuMMddHHmmss").withResolverStyle(java.time.format.ResolverStyle.STRICT))
      .toInstant(ZoneOffset.of(zone)).toEpochMilli()
  }
} catch (_: Exception) { null }

/** Byte-level guard runs before XmlPullParser can allocate a token or resolve markup. */
fun preflight(file: File, job: GuideJob) {
  var token = 0; var text = 0; var depth = 0; var element = 0
  var inTag = false; var quote = 0; var total = 0L
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
          if (s.startsWith("!")) throw GuideFailure("xml") // No DTD, entity or declaration reaches the parser.
          if (!s.startsWith("?")) {
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
}

private fun secret(text: String, login: List<String>, uncertain: List<String>): Boolean {
  var forms = setOf(text)
  repeat(5) {
    if (forms.any { value -> (login.firstOrNull()?.let { it.isNotEmpty() && value == it } == true) || login.drop(1).filter { it.isNotEmpty() }.any { value.contains(it) } || uncertain.filter { it.isNotEmpty() }.any { Regex("(?<![\\p{L}\\p{N}_])${Regex.escape(it)}(?![\\p{L}\\p{N}_])").containsMatchIn(value) } }) return true
    val next = forms.flatMap { value -> listOf(value, runCatching { URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrDefault(value), runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)) }.toSet()
    if (next == forms) return false
    forms = next
  }
  return true
}

fun readXml(file: File, job: GuideJob, login: List<String>, uncertain: List<String>, insert: (String, Long, Long?, String, String?) -> Unit) {
  preflight(file, job)
  val parser = Xml.newPullParser()
  parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
  parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
  val stack = mutableListOf<String>(); val ids = mutableSetOf<String>()
  var rows = 0; var opened = false; var closed = false
  var channel = ""; var start: Long? = null; var stop: Long? = null
  var title: String? = null; var description: String? = null
  val text = StringBuilder()
  try {
    file.inputStream().reader(Charsets.UTF_8).use { input ->
      parser.setInput(input)
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
            if (id != null && id.isNotEmpty() && id.length <= 128) {
              ids.add(id); if (ids.size > GuideBudget.CHANNELS) throw GuideFailure("rows")
            }
            stack.add(name); text.setLength(0)
          }
          XmlPullParser.TEXT, XmlPullParser.CDSECT -> text.append(parser.text)
          XmlPullParser.END_TAG -> {
            val value = text.toString().trim().replace(Regex("\\s+"), " ")
            if (stack == listOf("tv", "programme", "title") && title == null) title = value.take(300)
            if (stack == listOf("tv", "programme", "desc") && description == null) description = value.take(2000)
            val s = start; val t = title
            if (parser.name == "programme" && channel.isNotEmpty() && channel.length <= 128 && s != null && !t.isNullOrEmpty() && (stop == null || stop!! - s >= 60000)) {
              if (listOf(channel, t, description ?: "").any { secret(it, login, uncertain) }) throw GuideFailure("xml")
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
