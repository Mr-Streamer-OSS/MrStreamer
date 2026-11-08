import type { Json } from "./json.ts";

/** File facts only. The caller decides whether absence permits initialization. */
export type FileRead<A, E> =
  | { readonly kind: "read"; readonly value: A }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: E }
  | { readonly kind: "newer"; readonly error: E };

/** A store proves format compatibility, including newer versions, from parsed JSON. */
export type Decode<A, E> = (json: Json) => Exclude<FileRead<A, E>, { readonly kind: "missing" }>;

/** Written means replacement finished; acceptance in memory remains the caller's responsibility. */
export type FileWrite<E> =
  { readonly kind: "written" } | { readonly kind: "refused"; readonly error: E };
