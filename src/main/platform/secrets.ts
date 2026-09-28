import { safeStorage } from "electron";

/** Encrypts small secrets (the subscription password) before they are written to disk. */
export interface Secrets {
  seal(plain: string): string;
  open(sealed: string): string;
}

/**
 * Secrets backed by Electron's safeStorage. On macOS the key lives in the login Keychain.
 * Only usable after the app's `ready` event.
 */
export const keychainSecrets: Secrets = {
  seal(plain) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure storage is not available on this system.");
    }
    return safeStorage.encryptString(plain).toString("base64");
  },
  open(sealed) {
    return safeStorage.decryptString(Buffer.from(sealed, "base64"));
  },
};
