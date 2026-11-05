import { type } from "arktype";
import { isCallable } from "../../../../packages/contracts/src/callable.ts";
import { useEffect, useState } from "react";
import { Platform, ScrollView, Text } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { runCases } from "./run.ts";
import { keychainProof } from "./keychain.ts";
import { keychainSecrets } from "../secrets.ts";

// The runtime proof, a development screen apart from the app's own (Connect and Settings link to
// it): it runs the shared rules on Hermes and, when Metro serves EXPO_PUBLIC_PROOF_URL, sends the
// report to scripts/proof-server.ts. Its guide group fails on purpose while core's XMLTV reader
// needs Buffer, so the app never runs it at launch.
const PROOF_URL = process.env.EXPO_PUBLIC_PROOF_URL;

/** What the app threw outside the cases, such as a shared module failing while it loads. */
const uncaught: string[] = [];
const previousHandler = ErrorUtils.getGlobalHandler();

ErrorUtils.setGlobalHandler((cause: unknown, fatal?: boolean) => {
  uncaught.push(
    cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack}` : String(cause),
  );
  previousHandler(cause, fatal);
});

async function prove() {
  const fixture = PROOF_URL ?? "http://127.0.0.1:9";

  const results = await runCases({
    fixture,
    // The proof contract names only the request and response fields both implementations share.
    fetches: { global: fetch, expo: expoFetch },
  });

  const started = Date.now();

  const keychain = await keychainProof(keychainSecrets).then(
    (value) => ({ value }),
    (cause: unknown) => ({ thrown: String(cause) }),
  );

  results.push({ name: "keychain", compare: "record", ms: Date.now() - started, ...keychain });
  const scope = globalThis;
  const hermes = "HermesInternal" in scope ? scope.HermesInternal : undefined;

  // Hermes declares arbitrary property values. Keep the result opaque and serialize it intact.
  const properties =
    type.keywords.object.root.allows(hermes) &&
    "getRuntimeProperties" in hermes &&
    isCallable(hermes.getRuntimeProperties)
      ? hermes.getRuntimeProperties()
      : null;

  const report = {
    runtime: {
      hermes: properties ?? null,
      platform: Platform.OS,
      constants: Platform.constants,
    },
    uncaught,
    results,
  };

  if (PROOF_URL) {
    await fetch(`${PROOF_URL}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  }

  return results;
}

export function ProofScreen() {
  const [lines, setLines] = useState<readonly string[]>(["Proving"]);
  useEffect(() => {
    prove().then(
      (results) =>
        setLines(
          results.map(
            (r) => `${r.thrown ? "threw" : "ran"}  ${r.name}${r.thrown ? `: ${r.thrown}` : ""}`,
          ),
        ),
      (cause: unknown) =>
        setLines([
          `Proof failed: ${cause instanceof Error ? `${String(cause)}\n${cause.stack}` : String(cause)}`,
        ]),
    );
  }, []);

  return (
    <ScrollView style={{ backgroundColor: "#000" }} contentContainerStyle={{ padding: 16 }}>
      {lines.map((line, index) => (
        <Text
          key={index}
          testID={`proof-${index}`}
          style={{ color: "#fff", fontSize: 12, fontFamily: "Menlo" }}
        >
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}
