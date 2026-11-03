package app.mrstreamer.guide

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Custom guide links sealed with an Android Keystore AES-GCM key in noBackupFilesDir.
 * Atomic writes preserve the previous link when saving fails. */
object GuideCredentials {
  private const val KEY_ALIAS = "app.mrstreamer.guide.links"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  /** The guide link saved for [id], or null when none is. */
  @JvmStatic
  fun read(context: Context, id: String): String? = synchronized(this) {
    val sealed =
      try {
        fileOf(context, id).readFully()
      } catch (_: FileNotFoundException) {
        return null
      }
    require(sealed.size > IV_BYTES) { "A sealed credential is damaged." }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
  }

  /** Saves [secret] for [id], replacing any before it. */
  @JvmStatic
  fun write(context: Context, id: String, secret: String) = synchronized(this) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    check(cipher.iv.size == IV_BYTES) { "The Keystore chose an IV this format can't hold." }
    val sealed = cipher.iv + cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
    val file = fileOf(context, id)
    val stream = file.startWrite()
    try {
      stream.write(sealed)
      file.finishWrite(stream)
    } catch (cause: Throwable) {
      file.failWrite(stream)
      throw cause
    }
  }

  /** Removes [id]'s authority, with any write of it left halfway. */
  @JvmStatic
  fun remove(context: Context, id: String) = synchronized(this) {
    fileOf(context, id).delete()
    check(filesOf(context, setOf(nameOf(id))).isEmpty()) { "A credential could not be removed." }
  }

  /** The files of the ids named [names], with any AtomicFile side files of theirs. */
  private fun filesOf(context: Context, names: Set<String>): List<File> =
    folder(context).listFiles().orEmpty().filter { it.name.substringBefore('.') in names }

  private fun folder(context: Context): File =
    File(context.noBackupFilesDir, "guide-links").apply { mkdirs() }

  /** A file name for any id: its UTF-8 bytes in hex. */
  private fun nameOf(id: String): String =
    id.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }

  private fun fileOf(context: Context, id: String) = AtomicFile(File(folder(context), nameOf(id)))

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as SecretKey?)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }
}
