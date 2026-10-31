import { safeStorage } from "electron";
import { AppFailure } from "@mrstreamer/contracts/errors";

/** Encrypts subscription and subtitle-service secrets before they are written to disk. */
export interface Secrets {
  seal(plain: string): string;
  open(sealed: string): string;
}

/**
 * Secrets backed by Electron's safeStorage: the key lives in the macOS Keychain, Windows DPAPI,
 * or the Linux keyring. Only usable after the app's `ready` event. A Snap, named by `snap`, reaches
 * the keyring through a connection the viewer may still have to make, so its refusal says how.
 */
export function keychainSecrets(snap: string | null): Secrets {
  const refused = () =>
    new AppFailure(
      snap
        ? {
            kind: "keychain-refused",
            connect: `sudo snap connect ${snap}:password-manager-service`,
          }
        : { kind: "keychain-refused" },
    );
  return {
    seal(plain) {
      if (!safeStorage.isEncryptionAvailable()) throw refused();
      try {
        return safeStorage.encryptString(plain).toString("base64");
      } catch {
        throw refused();
      }
    },
    open(sealed) {
      try {
        return safeStorage.decryptString(Buffer.from(sealed, "base64"));
      } catch {
        throw refused();
      }
    },
  };
}
