import { router } from "expo-router";
import { useEffect } from "react";

/**
 * A link to no screen opens the app as it starts: Live, or Connect while no source is saved. While
 * the app runs it returns to the destinations already open rather than opening them again.
 */
export default function NotFound() {
  useEffect(() => router.dismissTo("/"), []);
  return null;
}
