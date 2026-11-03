import { scope } from "arktype";

// Plain JSON-shaped data, for values written as JSON text: a file a test writes, or a message on a
// receiver's channel. A field left undefined is left out, as JSON.stringify leaves it out.

export type Json = string | number | boolean | null | readonly Json[] | JsonObject;

export type JsonObject = { readonly [field: string]: Json | undefined };

/** Plain JSON at script boundaries, before each consumer checks its domain fields. */
export const JsonValue = scope({
  value: ["string | number | boolean | null | value[]", "|", { "[string]": "value" }],
}).export().value;
