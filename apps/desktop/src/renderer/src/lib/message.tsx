import { Fragment, type ReactNode } from "react";
import { messageParts, type Placeholder, type TextKey } from "@mrstreamer/core/i18n";

/**
 * A message with elements where its placeholders are, such as links, in the interface language:
 * `<Message text="Where titles stream comes from {justWatch}." values={{ justWatch: <a/> }} />`.
 */
export function Message<K extends TextKey>({
  text,
  values,
}: {
  text: K;
  values: { readonly [P in Placeholder<K>]: ReactNode };
}) {
  return messageParts(text).map((part, at) => (
    <Fragment key={at}>{typeof part === "string" ? part : values[part.placeholder]}</Fragment>
  ));
}
