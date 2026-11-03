package app.mrstreamer.credentials

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Each saved source's authority (its server and login, or its playlist link), sealed with an
 * AES-GCM key the Android Keystore holds and never exports, one file per source id under
 * `noBackupFilesDir/credentials`. Nothing here is backed up or moved to another device, and
 * Android deletes it with the app. A sealed file names its id inside the seal, so one source's
 * file can't stand in for another's.
 *
 * Native workers (downloads, guide refreshes, reminders) call [read] with the source id and get
 * the same JSON the app wrote, without a JS runtime: see apps/android/README.md for its shape.
 * Every failure throws; callers treat any of them as "the secret is unavailable, ask again".
 */
object Credentials {
  private const val KEY_ALIAS = "app.mrstreamer.credentials"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  /** The authority saved for [id], or null when none is. */
  @JvmStatic
  fun read(context: Context, id: String): String? = synchronized(this) {
    val file = fileOf(context, id)
    if (!file.exists()) return null
    val sealed = file.readBytes()
    require(sealed.size > IV_BYTES) { "A sealed credential is damaged." }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
  }

  /** Saves [secret] for [id], replacing any before it. The file is whole or absent. */
  @JvmStatic
  fun write(context: Context, id: String, secret: String) = synchronized(this) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    val sealed = cipher.iv + cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
    val file = fileOf(context, id)
    val pending = File(file.parentFile, "${file.name}.next")
    pending.writeBytes(sealed)
    if (!pending.renameTo(file)) {
      pending.delete()
      error("A credential could not be saved.")
    }
  }

  /** Removes [id]'s authority. Removing one that isn't there succeeds. */
  @JvmStatic
  fun remove(context: Context, id: String) = synchronized(this) {
    val file = fileOf(context, id)
    check(!file.exists() || file.delete()) { "A credential could not be removed." }
  }

  private fun folder(context: Context): File =
    File(context.noBackupFilesDir, "credentials").apply { mkdirs() }

  /** A file name for any id: its SHA-256 in hex. */
  private fun fileOf(context: Context, id: String): File {
    val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
    return File(folder(context), digest.joinToString("") { "%02x".format(it) })
  }

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
