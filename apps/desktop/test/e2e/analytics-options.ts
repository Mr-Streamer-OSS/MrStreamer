/** Native acceptance is deliberately separate from the bounded release-UI scenario. */
export function analyticsOptions(args: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of args) {
    if (["--native-telemetry", "--observe-rollover", "--volume-workload"].includes(arg))
      flags.add(arg);
    else if (
      /^--(built-desktop|expected-version|expected-source|native-case|prior-executable|prior-source|installed-pair|installer|installer-sha256)=/.test(
        arg,
      )
    ) {
      const split = arg.indexOf("=");
      const name = arg.slice(0, split);
      if (values.has(name) || arg.length === split + 1) throw new Error(`Invalid ${name}`);
      values.set(name, arg.slice(split + 1));
    } else if (arg !== "--") positional.push(arg);
  }
  const [executable, ...appArgs] = positional;
  const native = flags.has("--native-telemetry");
  const nativeCase = values.get("--native-case");
  if (
    nativeCase &&
    ![
      "consent",
      "offline",
      "checkpoint",
      "periodic",
      "seal-send-ack",
      "ambiguous",
      "quit",
      "slow-write",
      "windows-rename",
      "compatibility",
    ].includes(nativeCase)
  )
    throw new Error("Unknown native telemetry case");
  const expectedVersion = values.get("--expected-version");
  const expectedSource = values.get("--expected-source");
  for (const source of [expectedSource, values.get("--prior-source")])
    if (source && !/^[a-f0-9]{40}$/.test(source)) throw new Error("Expected a full source SHA");
  if (executable && (!expectedVersion || !expectedSource))
    throw new Error("Packaged verification requires --expected-version= and --expected-source=");
  if (native && (flags.has("--observe-rollover") || flags.has("--volume-workload")))
    throw new Error("Native acceptance cannot change the ordinary workload");
  if (
    !native &&
    ["--native-case", "--prior-executable", "--prior-source", "--installed-pair"].some((key) =>
      values.has(key),
    )
  )
    throw new Error("Native options require --native-telemetry");
  if (values.has("--prior-executable") !== values.has("--prior-source"))
    throw new Error("Prior executable and source must be supplied together");
  if (values.has("--installed-pair") && values.has("--prior-executable"))
    throw new Error("Select an installed Windows pair or separate prior executable");
  if (values.has("--installer") !== values.has("--installer-sha256"))
    throw new Error("Installer path and SHA256 must be supplied together");
  if (values.has("--installer-sha256") && !/^[a-f0-9]{64}$/.test(values.get("--installer-sha256")!))
    throw new Error("Expected installer SHA256");
  return {
    installer: values.get("--installer"),
    installerSha256: values.get("--installer-sha256"),
    executable,
    appArgs,
    native,
    expectedVersion,
    expectedSource,
    builtDesktop: values.get("--built-desktop"),
    nativeCase,
    priorExecutable: values.get("--prior-executable"),
    priorSource: values.get("--prior-source"),
    installedPair: values.get("--installed-pair"),
    volume: flags.has("--volume-workload"),
    rollover: flags.has("--observe-rollover"),
  };
}
