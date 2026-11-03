import { type } from "arktype";
import { CaptureEvent } from "./model.ts";
import { defined } from "@mrstreamer/core/defined";

export type CaptureResult = "accepted" | "retry" | "discard";

export interface CaptureTransport {
  send(event: CaptureEvent, signal: AbortSignal): Promise<CaptureResult>;
}

const PRODUCTION = {
  "https://eu.i.posthog.com": "https://eu.i.posthog.com/i/v0/e/",
  "https://us.i.posthog.com": "https://us.i.posthog.com/i/v0/e/",
} as const;

/** A PostHog project token is public and write-only; a personal API key never matches. */
const PROJECT_TOKEN = /^phc_[A-Za-z0-9_-]+$/;

/** Phones wait on slower links than desktops do; a hung request still ends. */
const REQUEST_MS = 5000;

/**
 * The capture a build may use, from what Metro inlined (`EXPO_PUBLIC_MR_STREAMER_ANALYTICS_*`).
 * Production needs a release bundle, its explicit flag, an approved PostHog host and a project
 * token; anything missing or invalid sends nothing. A development bundle can only use a literal
 * loopback endpoint for verification, and never falls back to production.
 */
export function analyticsTransport(config: {
  readonly development: boolean;
  readonly releaseBuild: string | undefined;
  readonly host: string | undefined;
  readonly projectToken: string | undefined;
  readonly localEndpoint: string | undefined;
}): CaptureTransport | null {
  if (config.development) {
    return config.localEndpoint ? localCapture(config.localEndpoint) : null;
  }

  const { host, projectToken } = config;

  if (
    config.releaseBuild !== "1" ||
    config.localEndpoint ||
    (host !== "https://eu.i.posthog.com" && host !== "https://us.i.posthog.com") ||
    !projectToken ||
    !PROJECT_TOKEN.test(projectToken)
  )
    return null;

  return capture(PRODUCTION[host], projectToken);
}

/** Verification only: literal loopback over plain HTTP, PostHog's capture path, nothing else. */
function localCapture(endpoint: string): CaptureTransport | null {
  const url = URL.parse(endpoint);

  if (
    !url ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.pathname !== "/i/v0/e/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;

  return capture(url.href, "mrstreamer-local-verification");
}

function capture(endpoint: string, projectToken: string): CaptureTransport {
  return {
    async send(event, signal) {
      const allowed = CaptureEvent()(event);

      if (allowed instanceof type.errors || signal.aborted) return "discard";
      const { properties } = allowed;

      // Rebuilt by name even after validation: no caller-owned object is spread onto the wire.
      const body = JSON.stringify({
        api_key: projectToken,
        event: allowed.event,
        uuid: allowed.uuid,
        distinct_id: allowed.distinct_id,
        timestamp: allowed.timestamp,
        properties: {
          app_version: properties.app_version,
          app_build: properties.app_build,
          os: properties.os,
          ...defined({ os_major: properties.os_major }),
          $process_person_profile: false,
          $geoip_disable: true,
          ...(allowed.event === "feature_opened" && { feature: allowed.properties.feature }),
        },
      });

      const request = new AbortController();
      const abort = () => request.abort();
      signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(abort, REQUEST_MS);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: request.signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });

        const status = response.status;

        return status >= 200 && status < 300
          ? "accepted"
          : status === 429 || status >= 500
            ? "retry"
            : "discard";
      } catch {
        return "retry";
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
