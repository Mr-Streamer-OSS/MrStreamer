---
name: verify-mrstreamer
description: Verify MR Streamer's desktop player and marketing website through real UI paths, isolated sessions, screenshots and observed side effects. Use when implementing, fixing or reviewing player or website behavior, or reproducing a problem.
---

# Verify MR Streamer

This is the repo's control skill. The installed task skill owns the implementation, investigation or review method; this skill supplies launch, driving and proof. Choose desktop or website by the changed user surface; read the relevant entry in [the feature map](features/README.md) before deciding what a passing check means.

## Test value

Before adding or keeping a test, name the user-visible failure or public contract it protects, its unique protection and whether a cheaper existing check covers it. Keep the minimum representative public behavior that survives an internal refactor. Use the compiler, type checks and linters for structure. Skip or remove checks without useful evidence; preserve distinct safety and failure boundaries.

For launching or rebuilding a desktop verification session, read [Launch](references/launch.md).

For desktop preflight or diagnosing session identity, read [Doctor](references/doctor.md).

For driving desktop scenarios or extending a changed user path, read [Drive](references/drive.md).

For launching or proving the marketing website, read [Website](references/website.md).

For native macOS verification, read [Native macOS](references/native-macos.md).

For collecting, inspecting or sharing verification proof, read [Evidence](references/evidence.md).

For tearing down or recovering an owned verification session, read [Cleanup](references/cleanup.md).

For helper invocation or process ownership internals, read [Helpers](references/helpers.md).

For updating feature entries or auditing the verification map, read [Maintenance](references/maintenance.md).

Generated using [pstack's create-verification-skill template](https://github.com/cursor/plugins/blob/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack/skills/create-verification-skill/SKILL.md). Workflow adaptations retain the [upstream MIT notice](../LICENSE.pstack).
