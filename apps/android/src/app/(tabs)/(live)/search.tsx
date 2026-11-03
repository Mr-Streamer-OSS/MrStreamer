import { Screen } from "../../../navigation/screen.tsx";

/** Search, opened over any destination's stack (`hrefOn`); the other destinations' routes reuse it. */
export default function Search() {
  return <Screen title="Search" pushed />;
}
