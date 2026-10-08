import { safeStorage } from "electron";
import { AppFailure } from "@mrstreamer/contracts/errors";

/** Encrypts subscription and subtitle-service secrets before they are written to disk. */
export interface Secrets {
  seal(plain: string): string;
  open(sealed: string): string;
}

/**
 * Secrets backed by Electron's safeStorage: the key lives in the macOS Keychain, Windows DPAPI,
 * or the Linux keyring. Only usable after the app's `ready` event.
 */
export const keychainSecrets: Secrets = {
  seal(plain) {
    if (!safeStorage.isEncryptionAvailable()) throw new AppFailure({ kind: "keychain-refused" });
    try {
      return safeStorage.encryptString(plain).toString("base64");
    } catch {
      throw new AppFailure({ kind: "keychain-refused" });
    }
  },
  open(sealed) {
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      throw new AppFailure({ kind: "keychain-refused" });
    }
  },
};
