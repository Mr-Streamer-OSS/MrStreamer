// The address of an XMLTV guide the viewer gives for a subscription. It can hold a key, in its
// path or its query, so the whole of it is a secret: it is kept sealed, and only its origin is
// ever shown, logged or sent to the window.
import { createHash } from "node:crypto";

export interface GuideAddress {
  /** The address made whole, as it is requested and sealed. */
  readonly href: string;
  /** Its scheme, host and port: all of it that may show. */
  readonly origin: string;
  /**
   * Tells addresses apart without holding one: part of the SHA-256 of `href`. The same address
   * typed again, whatever its case of host or its fragment, is the same guide.
   */
  readonly identity: string;
}

/**
 * What the viewer typed as an http or https address, or null when it is neither. An address
 * without a scheme means https, as a login's does. One with a user and password before its host
 * is refused: no request can be made with it.
 */
export function guideAddress(typed: string): GuideAddress | null {
  const raw = typed.trim();
  if (raw === "") return null;
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  // What follows # never reaches a server.
  url.hash = "";
  return {
    href: url.href,
    origin: url.origin,
    identity: createHash("sha256").update(url.href).digest("hex").slice(0, 16),
  };
}
