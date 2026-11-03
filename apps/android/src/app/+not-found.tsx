import { router } from "expo-router";
import { useEffect } from "react";

/**
 * A link to no screen. While the app runs it is dropped, leaving the screen it arrived over; one
 * that opens the app opens it as it starts: Live, or Connect while no source is saved.
 */
export default function NotFound() {
  useEffect(() => (router.canGoBack() ? router.back() : router.replace("/")), []);

  return null;
}
