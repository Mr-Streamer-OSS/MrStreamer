// What JSON carries, for values written as JSON text: a file the app or a test writes, or a message
// on a receiver's channel. A field left undefined is left out, as JSON.stringify leaves it out.

type Json = string | number | boolean | null | readonly Json[] | JsonObject;

export type JsonObject = { readonly [field: string]: Json | undefined };
