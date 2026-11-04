import { scope } from "arktype";

/** JSON-shaped transport values; freshly parsed JSON uses the Json type directly. */
export const JsonValue = scope({
  value: ["string | number | boolean | null | value[]", "|", { "[string]": "value" }],
}).export().value;
