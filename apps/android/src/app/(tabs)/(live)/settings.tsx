import { Screen } from "../../../navigation/screen.tsx";

/** Settings, opened over any destination's stack (`hrefOn`); the other destinations' routes reuse it. */
export default function Settings() {
  return <Screen title="Settings" pushed />;
}
