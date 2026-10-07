// How much of a guide the app reads. A guide past any of these is refused whole, and says so:
// none of it is used, rather than part of it shown as if it were all.

export interface GuideLimits {
  /** The document, unpacked. */
  readonly bytes: number;
  /** One channel or programme, from its opening tag to its closing one. */
  readonly elementBytes: number;
  /** The channels the guide lists. */
  readonly channels: number;
  /** The programmes that haven't ended, which are the ones kept. */
  readonly programmes: number;
}

/**
 * The limits every guide is read under, set against the large guide the budgets are measured
 * with (apps/desktop/scripts/measure-guide.ts): 36 MB, 1,300 guide channels and 45,500
 * programmes still to come, which hold 23 MB once indexed, half a kilobyte a programme.
 *   - 512 MiB unpacked, fourteen times that guide: a gzip of a megabyte can unpack no further.
 *   - 1 MiB for one element, where that guide's are 400 bytes: one that never closes stops there.
 *   - 50,000 guide channels, nearly forty times its 1,300.
 *   - 500,000 programmes still to come, eleven times its 45,500: about 250 MB at that size, a
 *     week of 2,000 channels.
 */
export const GUIDE_LIMITS: GuideLimits = {
  bytes: 512 * 1024 * 1024,
  elementBytes: 1024 * 1024,
  channels: 50_000,
  programmes: 500_000,
};
