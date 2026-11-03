# iPad and Duo store artwork

The generator prepares Paper A candidates: one genuine capture and one short
headline on true black, in Inter from the desktop brand assets. Its master,
`apps/ios/assets/store/spec.json`, holds slot geometry and the headlines in
English, Dutch, French, German and Spanish, which use the Guide terms of
`apps/ios/src/i18n/live.ts`; the English copy is the one picked in Paper.
Layout is in Paper points: the headline column and picture box of row A for a
supplied frame, and of the frameless fallback row otherwise. A headline that
needs more lines than the design reserves shrinks a point at a time, to no less
than 80% of its size, so the picture keeps its place in every language. Copy and composition still need owner visual acceptance.
Nothing here changes an Apple listing or the submitted 0.1.0 build.

## Apple requirements

Read independently on **3 November 2026**:

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications):
  iPad 13-inch accepts 2752 × 2064 landscape (also 2732 × 2048).
  Duo accepts 2853 × 2007 inner landscape and 1398 × 2034 outer portrait.
  Uploads allow 1–10 PNG/JPEG screenshots per size, with no alpha channel.
  iPad coverage is required for iPadOS apps. Duo coverage becomes required in
  April 2027 for apps using the iOS 27.1 SDK or later.
- The same page separately requires **medium Dynamic Island iPhone** coverage,
  1206 × 2622 or 1179 × 2556 portrait, or the landscape counterparts. That slot
  remains outside this generator. These three candidates do not replace it.
- [Marketing guidelines](https://developer.apple.com/app-store/marketing/guidelines/):
  Apple product images remain unmodified, whole and upright; no cropping,
  tilting, obstruction, simulated hardware or added shadows. Put copy beside
  the product, keep relative scale correct and show the running app on the
  latest OS with full network, Wi-Fi and battery indicators. Secure media rights.

Frame use requires an inspected official pose, explicit cutout geometry and an inspected corner radius, a source
URL and terms source on HTTPS apple.com hosts without credentials, query or fragment and a non-empty local licence record. No Apple bezel DMG was downloaded
or inspected for this implementation. A supplied frame is scaled uniformly,
never rotated or cropped; the screen fits its cutout. The frameless fallback is a
square-corner capture with a 1-point #2C2C2E border, without simulated hardware.
The generator checks geometry and metadata, not the truth of an operator's
licensing or capture claims. Source qualification and licence review remain
required before accepting candidates.

## Capture inputs

Allocate a managed Mac/device session separately. Use the existing
`apps/ios/scripts/marketing-fixture.ts` unchanged, not TEST's codec catalogue or
production demo mode. It reuses the lawful desktop marketing media and invented
catalogue credited in `docs/assets/marketing-demo-sources.json`.

From this checkout, with ffmpeg and rsvg-convert installed:

```sh
node apps/ios/scripts/marketing-fixture.ts --cache-dir .local/marketing-media --port 8795
```

Tunnel that port to the allocated simulator host. Build the candidate with
`EXPO_PUBLIC_TMDB_KEY=fixture` and
`EXPO_PUBLIC_TMDB_API=http://127.0.0.1:8795/tmdb/3`. Sign into the loopback fixture
using the invented login documented in that script. Keep credentials out of the
manifest. Navigate through the real app, with a clean 9:41 status bar, full network,
Wi-Fi and battery. Capture the full screen at native pixels, without resizing:

| Slot        | Native pixels | Scale | Actual view                                    |
| ----------- | ------------- | ----- | ---------------------------------------------- |
| `ipad-13`   | 2752 × 2064   | 2x    | S1: Live › Guide, programme detail column open |
| `duo-inner` | 2853 × 2007   | 3x    | S4: open Duo Live list and Schedule column     |
| `duo-outer` | 1398 × 2034   | 3x    | S6: closed Duo Live › Guide with right rail    |

Capture each language with the matching app interface language. Record the full
built app commit, device/simulator identity, OS and timezone-qualified capture
instant. Device and OS are plain labels without `://`, `/`, `\`, `@`, `?` or `~`. Bind that record to the original capture's SHA-256. A 1x layout reference,
a Paper placeholder or a screenshot of another app cannot qualify, and native
size alone does not prove a capture: source acceptance inspects the actual view
and its provenance. The tool downsizes the full capture for composition;
it never crops it or accepts smaller inputs for upscaling.

## Reproduce candidates

Install workspace dependencies with `pnpm install --frozen-lockfile`. iOS keeps
its own install; this Node tool resolves Sharp directly from the desktop install,
without adding an iOS dependency. Put inputs, optional frames, licence records and
exports in this checkout's gitignored `.local/`, creating it first with
`mkdir -p .local`. Relative input paths resolve
beside the input JSON. Create one input file per language, with all three slots:

```json
{
  "slots": {
    "ipad-13": {
      "file": "ipad-13.png",
      "sha256": "FULL_CAPTURE_SHA256",
      "provenance": {
        "appCommit": "FULL_40_CHARACTER_APP_COMMIT",
        "device": "iPad Pro 13-inch (M5) simulator",
        "os": "iPadOS 27.1",
        "provider": "apps/ios/scripts/marketing-fixture.ts",
        "capturedAt": "2026-11-03T09:41:00Z"
      }
    }
  }
}
```

Add `duo-inner` and `duo-outer` with their own captures and records. The abbreviated
example deliberately cannot export. Omit `frame` for the approved frameless
fallback. To use an inspected official frame, add this object to that slot's
capture record, replacing every example value with the inspected asset's facts:

```json
{
  "frame": {
    "file": "frames/official-pose.png",
    "source": "https://developer.apple.com/design/resources/",
    "termsSource": "https://developer.apple.com/app-store/marketing/guidelines/",
    "licenceFile": "frames/licence-record.txt",
    "cutout": { "left": 100, "top": 100, "width": 2752, "height": 2064 },
    "cornerRadius": 0
  }
}
```

`cutout` and the required `cornerRadius` are in the original frame PNG's pixels,
measured from the inspected asset; zero means square corners. Record the actual bundled terms,
permitted use and pose in the licence record. Keep raw frames local; do not commit
or redistribute them. The PNG must have transparency and the cutout's aspect
ratio must match the capture within 0.5% for integer-pixel rounding. The generator
requires at least 99% fully transparent pixels inside the rounded cutout shrunk
by a 2 px anti-alias band, and records the nontransparent (opaque) share in the manifest. It does not paint a bezel or repair the supplied frame's screen opening.
Captures and frames must be static PNGs; animated PNGs are rejected.

```sh
node apps/ios/scripts/store-artwork.ts \
  --input .local/store-inputs/en-US.json \
  --output .local/store-candidates-en-US --locale en-US
```

Unknown input keys and slot IDs are rejected, including medium iPhone inputs.
Capture filenames in the manifest are relative to the input JSON; frame records
contain only source/terms URLs, cutout geometry, corner radius, opaque share, hashes and native size.

Supported locale arguments: `en-US`, `nl-NL`, `fr-FR`, `de-DE`, `es-ES`.
The output parent must already exist and the output directory must be new.
Validation and rendering of every slot finish before that directory is created.
A failed write raises an error; remove only that incomplete candidate directory
before retrying. Existing candidates are never overwritten.

Each batch contains three opaque RGB PNGs and `manifest.json`, recording output
hashes, source capture hashes and provenance, frame source/terms and licence hash
(or `frameless`), layout, screen placement, translated headline and its point
size, input JSON hash, generator source SHA-256, Node version, Inter hash/licence and
Sharp/libvips versions. Keep the input JSON and raw captures
beside the manifest for reproduction. Rendering libraries can change pixels;
review hashes and full-size output after regeneration.

## Remaining native acceptance

This Linux implementation ships no captures, exports or device frames. A separate
Mac allocation must inspect the official iPad and Duo packages, record the exact
poses, licences and cutouts, then capture S1, S4 and S6 at native scale. S4 remains
unobserved until a genuine open-Duo capture is accepted. If its pose/capture is
unavailable, report it; do not substitute the Paper placeholder. Frameless output
solves missing frames, not missing runtime captures. Review all languages at full
size and thumbnail size before owner acceptance; Store publication is separate.
