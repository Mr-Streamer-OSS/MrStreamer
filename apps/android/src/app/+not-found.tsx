import { Redirect } from "expo-router";

/** A link to no screen opens the app as it starts: Live, or Connect while no source is saved. */
export default function NotFound() {
  return <Redirect href="/" />;
}
