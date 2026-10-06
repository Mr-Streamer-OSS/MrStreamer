# The website

Three static pages for `https://mrstreamer.app`, built with Vite from plain HTML, CSS and a small TypeScript file: the home page, the privacy policy and the page for a missing address. The home page's pictures are captures of the real app, kept in `docs/assets` and described in [marketing artwork](../../docs/contributing/marketing-artwork.md).

| File                        | Holds                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `index.html`                | The home page and what it says                                                                    |
| `privacy/index.html`        | The privacy page around the policy. The build puts `docs/privacy.md` in it                        |
| `404.html`                  | The page for an address that has none                                                             |
| `src/styles.css`            | The layout, which download button shows, and the motion's keyframes                               |
| `src/main.ts`               | Page-view analytics on every page. On the home page, what moves and the newest download links     |
| `src/system.ts`             | Which system a visitor is on, for the hero's one download button                                  |
| `src/downloads.ts`          | Where the current stable release's installers are, and how the page shows them                    |
| `vite.config.ts`            | Builds the pages, renders the policy, and answers the addresses below on your computer            |
| `scripts/prepare-assets.ts` | Cuts the pictures, icons and social picture into `public/generated/`                              |
| `scripts/package-vercel.ts` | Packs the built site for Vercel in `.vercel/output/`, with its routes, and checks it              |
| `public/`                   | `robots.txt`, `sitemap.xml`, and in `icons/` the Store badge and the Apple and Linux marks        |
| `test/`                     | The download button for each system, the installers the page links, and the page under its styles |

`public/generated/`, `dist/` and `.vercel/` are built and stay out of git.

## Run it

From the repository root, with Node 24 and pnpm 11:

```sh
pnpm install
pnpm dev:marketing       # the site with live reload, on http://localhost:5173
pnpm build:marketing     # pictures, pages and the Vercel package
pnpm preview:marketing   # the built site, on http://localhost:4173
```

`pnpm build:marketing` fails when a page names a file that isn't in the package, when the home or privacy page lacks its address, description or social picture, when the privacy page doesn't hold the whole policy, or when the sitemap misses a page. It also fails when the home page lacks the script that picks its download button, links an installer outside the project's releases, or describes the app to search engines in data that doesn't read. `scripts/package-vercel.ts` lists every check. The build reads the update feed and asks GitHub about four files, and builds without either ([downloads](#downloads)). `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm knip` and `pnpm fmt:check` cover this folder with the rest of the repository.

## Addresses

Both local servers and Vercel answer the same addresses, with or without a query:

| Address                                         | Answers                       |
| ----------------------------------------------- | ----------------------------- |
| `/`                                             | The home page                 |
| `/privacy` and `/privacy/`                      | The privacy policy            |
| A file, such as `/robots.txt` or `/sitemap.xml` | The file                      |
| Any other address, and `/404.html`              | The 404 page, with status 404 |

`vite.config.ts` answers them for `pnpm dev:marketing` and `pnpm preview:marketing`. `scripts/package-vercel.ts` writes them as routes in `.vercel/output/config.json` for Vercel. An address added to one goes in the other too.

Vercel alone answers `/_vercel/insights/`, for [website analytics](#website-analytics).

## Change it

- Keep the words true and few. Every claim on the page comes from the README or the docs. The app's limits are in [what plays](../../docs/user/playback.md).
- True black, white text, minimal copy. Screenshots describe the app, so a feature is its name and one sentence beside its window.
- The page order is the bar, the hero, the Home window, the three features, What you need, Questions, Downloads, the footer. The hero has the page's one button. The bar links Downloads as text.
- The title and description name the product, that it is free, and the three systems. The `SoftwareApplication` data in the head repeats what the page says and nothing else: no rating, no review count, no version. The canonical address, `robots.txt` and `sitemap.xml` cover the two pages there are. Add no page for a single system or search phrase.
- Nothing moves by itself, and every animation runs once and ends:
  - As the page opens, the bar drops in, the headline and lead rise, the one button pops, its line rises and the Home window stands up, or only rises while the layout is stacked. This is CSS alone, so it runs without JavaScript.
  - As a part scrolls into view, a feature's text slides in from the page's edge while a black panel wipes off its window. What you need and each question rise in, and each download row slides in from the left, questions and rows one after another. What is on screen when the page opens stays as it is.
  - As the page scrolls, the Home window tips upright. Upright, it has no transform left.
  - The button lifts 2 px under the pointer or the keyboard's focus.

  Only `transform` and `opacity` change. `main.ts` adds `revealed` to a part once and takes it off when its animation ends or is dropped, so no class, panel or layer stays behind. Once the page is open, the script works only after a scroll, a resize or a changed preference. With reduced motion nothing moves, also when the preference changes while the page is open. Nothing waits hidden for the script. An animation only starts from hidden, and a part that never animates is in place.

- New pictures come from new captures. Follow the [artwork recipe](../../docs/contributing/marketing-artwork.md). A phone shows a part of each window, set in `prepare-assets.ts`, with its size repeated in `index.html`.
- The privacy policy has one source, `docs/privacy.md`. The build renders it into `https://mrstreamer.app/privacy`, where the app and the Store listing link. Edit the Markdown, never the page. A merge to `main` that changes it publishes the site again.

## Downloads

The hero offers one download, for the visitor's system. Downloads, above the footer, lists every installer for everyone.

### One button

`src/system.ts` names the visitor's system from the browser's user agent, its touch points and, in Chromium, the platform it reports. The build writes that function's own text into the head of `index.html`, where it runs before the page paints and sets `data-os` on `<html>`. `styles.css` shows the button and line that match, so the button never swaps after it shows.

| Visitor                                  | Button                  | Goes to                |
| ---------------------------------------- | ----------------------- | ---------------------- |
| Windows                                  | Microsoft's Store badge | The Store listing      |
| Mac                                      | Download for Mac        | The DMG                |
| Linux on a computer                      | Download for Linux      | The AppImage           |
| Anyone else, and anyone with scripts off | Downloads               | The list at the bottom |

Anyone else is a phone, a tablet, an iPad asking for the desktop site, ChromeOS, a console, a television, another Unix, or a browser whose reported platform and user agent disagree. A computer's Linux browser writes X11 or Wayland beside Linux in its user agent, and a television's doesn't. The setup .exe and the .deb are never in the hero.

The script knows the system and not the processor. An Intel Mac gets the Mac button, so the line under each button names the hardware its file needs and links the list. It asks the browser for no detailed hints, stores nothing and sends nothing.

### Which release the links point at

`index.html` is written with every installer link on the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest), a label that says so, and no version. That is what the page shows when nothing is known. Two steps point the links at files, both in `src/downloads.ts`:

1. **The build** reads the stable version from the [update feed](../../docs/maintainers/releasing.md#update-feed), then asks GitHub for each of the four installers by its address, one HEAD request each. It writes the ones GitHub answers for into the page, and the version under the Mac and Linux buttons. The built page links files without scripts.
2. **The open page** requests the feed once, with no retry and no polling. The feed lists the installers its stable release carries, and the page shows that release. A stable release reaches visitors this way without a new build of the site, once the release workflow has published the feed and GitHub's ten-minute cache of it has passed.

A release doesn't rebuild the site. The release workflow acts as `GITHUB_TOKEN`, and what that token pushes or publishes starts no other workflow. The built page moves to a new release with the next merge that changes the website, or when you run **Marketing deploy** by hand.

| When                                                    | The page links                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The build and the feed name the same release            | That release's files                                                                               |
| A stable release came out after the build               | With scripts, the new release. Without, the one the build found, whose files stay on GitHub        |
| The build couldn't read the feed                        | The Releases page, until the open page reads the feed. The build prints a warning and still passes |
| The release lacks an installer, or GitHub didn't answer | The Releases page for that installer, files for the others                                         |
| The visitor's browser can't reach the feed              | What the build wrote                                                                               |
| The feed was written before feeds listed installers     | What the build wrote                                                                               |
| The feed names a nightly, or files outside this project | The open page keeps what the build wrote. A build links the Releases page                          |
| A stable release was withdrawn and the feed moved back  | With scripts, the release the feed names now                                                       |

A link is never guessed and never taken from the feed. Its address is this repository's release folder, a version shaped like a stable one, and a file name from `INSTALLERS` in `downloads.ts`, which follow `artifactName` in `apps/desktop/electron-builder.yml`. Rename an installer there and the page links the Releases page for it until `INSTALLERS` follows. The version shows only beside a button whose file is linked.

The request for the feed goes to GitHub Pages. The [privacy policy](../../docs/privacy.md#the-website) says what GitHub receives.

### The badge and the marks

`public/icons/` holds three files, served from the site so the page asks no one else for them. Each loads lazily, so only the visitor whose button shows it fetches it. With scripts off a browser fetches all three.

| File                  | From                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `microsoft-store.svg` | Microsoft's light Store badge, `https://get.microsoft.com/images/en-us%20light.svg`, byte for byte, 161 by 44  |
| `apple.svg`           | The Apple logo as [Simple Icons](https://simpleicons.org) 15.22.0 draws it, CC0 1.0. A trademark of Apple Inc. |
| `linux.svg`           | Tux as Simple Icons 15.22.0 draws it, CC0 1.0. Larry Ewing drew Tux. Linux is a trademark of Linus Torvalds    |

Keep the badge as Microsoft publishes it: no new colour, crop or redrawing, and its own proportions. There is no Mac App Store listing, so the Mac and Linux buttons are plain buttons with the system's mark and never a store badge.

## Website analytics

The production build loads Vercel Web Analytics for page views. Local development does not load it. Enable Web Analytics in the Vercel project's Analytics tab before deploying; the project currently has it enabled. The desktop app has no analytics. The [privacy policy](../../docs/privacy.md#the-website) describes website data collection.

The pages load the script from `/_vercel/insights/script.js` and send page views to `/_vercel/insights/view`. Vercel adds both to a deployment in its build step. A prebuilt package of static files skips that step unless it arrives as an archive, so every deployment here uses `--archive=tgz`. Without the flag the site looks the same, the script answers 404 and nothing is counted.

To check a deployment, ask for the script. It answers JavaScript, and the 404 page when the routes are missing:

```sh
curl -sI https://mrstreamer.app/_vercel/insights/script.js | grep -i content-type   # application/javascript
```

`pnpm preview:marketing` answers that address with the 404 page, as it is not Vercel.

## How it gets published

`.github/workflows/marketing-deploy.yml` publishes the page from GitHub Actions. Vercel only serves it.

1. A push to `main` that changes what the page is built from starts a run. You can also start one by hand from `main`.
2. The build job has no secrets. It builds `main`, checks the package and hands over `.vercel/output` alone.
3. The publish job holds the Vercel token. It checks out nothing and runs the pinned Vercel CLI on that package: `vercel deploy --prebuilt --archive=tgz --prod`.

Runs take turns and none is cancelled halfway. A run that waited builds the newest `main`. Before it publishes, a run asks git whether `main` has changed the website since its build. If it has, the run leaves publishing to the run that change started. If git can't tell, the run fails and publishes nothing.

Publishing is off until you turn it on. Until then a run builds, says publishing is off, and stops. Every pull request also builds the page in `.github/workflows/marketing.yml`, without secrets.

## Set it up, once

These steps need the owner's accounts. Nothing here costs money. Stop if a step asks for a paid plan.

### 1. Check that the free plan fits

Vercel's Hobby plan is for personal, non-commercial use. Its [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage) count a site as commercial when it takes payment, sells something or shows ads, and say that asking for donations doesn't count. The page does none of those. If that changes, or you are unsure, ask Vercel before you rely on Hobby.

### 2. Create the Vercel project

Use the CLI. The dashboard's New Project flow starts from a Git repository, which this project must not have.

```sh
npx --yes vercel@62.2.0 login
npx --yes vercel@62.2.0 project add mrstreamer-marketing
npx --yes vercel@62.2.0 link --yes --project mrstreamer-marketing --cwd apps/marketing
```

Then open the project's Settings and confirm all three:

| Setting                                 | Must be |
| --------------------------------------- | ------- |
| Build and Deployment > Root Directory   | Empty   |
| Build and Deployment > Framework Preset | Other   |
| Git > Connected Git Repository          | None    |

The workflow runs the CLI with `--cwd apps/marketing`, and the CLI adds the project's Root Directory to that. A Root Directory of `apps/marketing` would send it looking for `apps/marketing/apps/marketing`. A Git connection would make Vercel build and publish on its own, beside the workflow.

`link` writes `apps/marketing/.vercel/project.json`, which is not committed. It holds the two ids the next step needs: `projectId` and `orgId`.

### 3. Make a token

On [vercel.com/account/tokens](https://vercel.com/account/tokens), create a token named for its use, such as `mrstreamer-marketing-github`. Scope it to the `mrstreamer-marketing` project alone and give it an expiry you will keep. Vercel shows the token once.

### 4. Give GitHub the token and the ids

In the repository's Settings > Environments, create `marketing-production`. Under Deployment branches and tags choose Selected branches and tags, and add `main`. Then add:

| Kind                 | Name                | Value                                   |
| -------------------- | ------------------- | --------------------------------------- |
| Environment secret   | `VERCEL_TOKEN`      | The token                               |
| Environment variable | `VERCEL_ORG_ID`     | `orgId` from `.vercel/project.json`     |
| Environment variable | `VERCEL_PROJECT_ID` | `projectId` from `.vercel/project.json` |

Or from a terminal, where `gh` asks for the token without showing it:

```sh
gh secret set VERCEL_TOKEN --env marketing-production --repo Mr-Streamer-OSS/MrStreamer
gh variable set VERCEL_ORG_ID --env marketing-production --repo Mr-Streamer-OSS/MrStreamer --body "<orgId>"
gh variable set VERCEL_PROJECT_ID --env marketing-production --repo Mr-Streamer-OSS/MrStreamer --body "<projectId>"
```

The token goes nowhere else: not in a file, a commit, an issue or a log. Leave required reviewers off this environment, or every publication waits for a click.

### 5. Publish the first time by hand

From an up-to-date `main`, build the same package the workflow builds and publish it with your own login:

```sh
pnpm install
pnpm build:marketing
npx --yes vercel@62.2.0 deploy --prebuilt --archive=tgz --prod --cwd apps/marketing
```

A project's first deployment is its production deployment. No domain is attached yet, so it is live only at the project's `vercel.app` address. Check there:

- The home page and `/privacy`, on a wide screen and a phone.
- `/privacy` and `/privacy/` both show the whole policy.
- An address with no page, such as `/nothing/here`, shows Page not found.
- `/robots.txt`, `/sitemap.xml` and `/generated/social.png` answer.
- `/_vercel/insights/script.js` shows JavaScript, not Page not found.

### 6. Move the domain

Today `mrstreamer.app` sits behind Cloudflare, which redirects `/` to the repository and `/privacy` to the policy, and routes the project's email.

1. In Cloudflare, export the DNS records so you can put them back.
2. In Vercel, open the project's Settings > Domains and add `mrstreamer.app`. Accept the offer to add `www.mrstreamer.app` too.
3. Select Edit on `www.mrstreamer.app` and set Redirect to `mrstreamer.app`. The redirect keeps the path.
4. In Cloudflare DNS, replace the records for `mrstreamer.app` and `www` with the A and CNAME records Vercel shows for this project. Set both to DNS only, the grey cloud, so Vercel can issue the certificates.
5. Leave the MX records and the TXT records for mail as they are. `hello@`, `privacy@` and `security@` keep arriving through Cloudflare.
6. Turn off Cloudflare's rules that redirect `mrstreamer.app` and `mrstreamer.app/privacy`. They sit under Rules, as a redirect rule, a page rule or a bulk redirect.

Then check:

```sh
curl -sI https://mrstreamer.app/ | head -1                             # 200
curl -sI "https://www.mrstreamer.app/x?y=1" | grep -i location         # https://mrstreamer.app/x?y=1
curl -sI https://mrstreamer.app/privacy | head -1                      # 200
curl -sI https://mrstreamer.app/privacy/ | head -1                     # 200
curl -sI "https://mrstreamer.app/nothing/here?y=1" | head -1           # 404
curl -sI https://mrstreamer.app/_vercel/insights/script.js | head -1   # 200
```

Send a message to `hello@mrstreamer.app` and see it arrive. Open Settings > About in the app and follow its Website and Privacy links.

### 7. Turn on automatic publishing

```sh
gh variable set MARKETING_DEPLOY_ENABLED --repo Mr-Streamer-OSS/MrStreamer --body true
gh workflow run marketing-deploy.yml --repo Mr-Streamer-OSS/MrStreamer --ref main
```

Watch that run publish. From then on, a merge to `main` that changes any of these publishes the page:

- `apps/marketing/`
- `docs/assets/`
- `docs/privacy.md`
- `apps/desktop/assets/brand/mark.svg`
- `package.json`, `pnpm-workspace.yaml` or `pnpm-lock.yaml`
- either marketing workflow

It publishes what is merged. It never writes or rewrites the page.

## Turn it off, or go back

To stop publishing, set the variable to anything but `true`. The page stays as it is.

```sh
gh variable set MARKETING_DEPLOY_ENABLED --repo Mr-Streamer-OSS/MrStreamer --body false
```

To go back one publication, open the project in Vercel and choose Instant Rollback on the production deployment. The Hobby plan goes back to the deployment before the current one. After a rollback Vercel holds the domain on that deployment. The workflow still runs and its summary names each new deployment, but none of them goes live until you choose Undo Rollback.

To go back further, revert the commit on `main`. The workflow publishes the reverted page.

To take the site away, remove the two domains from the Vercel project and restore the DNS records you exported.

When the token expires, make a new one and set `VERCEL_TOKEN` again. A run without a token, or without either id, fails and names what is missing.

## Later, if you want Vercel to build from Git

Not set up, and not tried. It replaces the workflow, so do both of these first:

1. Set `MARKETING_DEPLOY_ENABLED` to `false`.
2. Confirm on a preview deployment that `/privacy` shows the policy and an address with no page answers 404.

Only then connect the repository in the project's Settings > Git, and give the project these settings:

| Setting                                  | Value                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Root Directory                           | `apps/marketing`                                                                    |
| Include files outside the Root Directory | On, for the captures in `docs/assets`                                               |
| Framework Preset                         | Other                                                                               |
| Node.js Version                          | 24.x                                                                                |
| Install Command                          | `npx --yes pnpm@11.24.0 install --filter mrstreamer-marketing... --frozen-lockfile` |
| Build Command                            | `npx --yes pnpm@11.24.0 --filter mrstreamer-marketing build`                        |
| Output Directory                         | `dist`                                                                              |

Never run both. Two publishers on one project overwrite each other.
