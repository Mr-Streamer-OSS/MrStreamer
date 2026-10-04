# The website

One static page for `https://mrstreamer.app`, built with Vite from plain HTML, CSS and a small TypeScript file. Its pictures are captures of the real app, kept in `docs/assets` and described in [marketing artwork](../../docs/contributing/marketing-artwork.md).

| File                        | Holds                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `index.html`                | The page and everything it says                                             |
| `src/styles.css`            | The layout, and the motion's keyframes                                      |
| `src/main.ts`               | What moves when the reader scrolls                                          |
| `scripts/prepare-assets.ts` | Cuts the page's pictures, icons and social picture into `public/generated/` |
| `scripts/package-vercel.ts` | Packs the built page for Vercel in `.vercel/output/` and checks the package |
| `public/`                   | `robots.txt` and `sitemap.xml`                                              |

`public/generated/`, `dist/` and `.vercel/` are built and stay out of git.

## Run it

From the repository root, with Node 24 and pnpm 11:

```sh
pnpm install
pnpm dev:marketing       # the page with live reload, on http://localhost:5173
pnpm build:marketing     # pictures, page and the Vercel package
pnpm preview:marketing   # the built page, on http://localhost:4173
```

`pnpm build:marketing` fails when the page names a file that isn't in the package, or when the address, description, social picture, `robots.txt`, sitemap or privacy route is missing. `pnpm typecheck`, `pnpm lint`, `pnpm knip` and `pnpm fmt:check` cover this folder with the rest of the repository.

`/privacy` redirects only on Vercel. Locally it answers the page.

## Change it

- Keep the words true and few. Every claim on the page comes from the README or the docs. The app's limits are in [what plays](../../docs/user/playback.md).
- True black, white text, no decoration, nothing that moves by itself. The hero rises in once, section text rises in once as it scrolls into view, and the hero's window tips upright as the page scrolls. With reduced motion, or without JavaScript, everything is in place from the start.
- New pictures come from new captures. Follow the [artwork recipe](../../docs/contributing/marketing-artwork.md). A phone shows a part of each window, set in `prepare-assets.ts`, with its size repeated in `index.html`.
- The privacy policy stays in `docs/privacy.md`. The app and the Store listing link to `https://mrstreamer.app/privacy`, which this site redirects there.

## How it gets published

`.github/workflows/marketing-deploy.yml` publishes the page from GitHub Actions. Vercel only serves it.

1. A push to `main` that changes what the page is built from starts a run. You can also start one by hand from `main`.
2. The build job has no secrets. It builds `main`, checks the package and hands over `.vercel/output` alone.
3. The publish job holds the Vercel token. It checks out nothing and runs the pinned Vercel CLI on that package: `vercel deploy --prebuilt --prod`.

Runs take turns and none is cancelled halfway. A run that waited builds the newest `main`.

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
npx --yes vercel@62.2.0 deploy --prebuilt --prod --cwd apps/marketing
```

A project's first deployment is its production deployment. No domain is attached yet, so it is live only at the project's `vercel.app` address. Check there:

- The page, on a wide screen and a phone.
- `/privacy` and `/privacy/` both go to the privacy policy on GitHub.
- `/robots.txt`, `/sitemap.xml` and `/generated/social.png` answer.

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
curl -sI https://mrstreamer.app/ | head -1                         # 200
curl -sI "https://www.mrstreamer.app/x?y=1" | grep -i location     # https://mrstreamer.app/x?y=1
curl -sI https://mrstreamer.app/privacy | grep -i location         # the policy on GitHub
curl -sI https://mrstreamer.app/privacy/ | grep -i location        # the same
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
- `apps/desktop/assets/brand/mark.svg`
- `package.json`, `pnpm-workspace.yaml` or `pnpm-lock.yaml`
- either marketing workflow

It publishes what is merged. It never writes or rewrites the page.

## Turn it off, or go back

To stop publishing, set the variable to anything but `true`. The page stays as it is.

```sh
gh variable set MARKETING_DEPLOY_ENABLED --repo Mr-Streamer-OSS/MrStreamer --body false
```

To go back one publication, open the project in Vercel and choose Instant Rollback on the production deployment. The Hobby plan goes back to the deployment before the current one. After a rollback Vercel holds the domain on that deployment, and new publications don't go live until you choose Undo Rollback.

To go back further, revert the commit on `main`. The workflow publishes the reverted page.

To take the site away, remove the two domains from the Vercel project and restore the DNS records you exported.

When the token expires, make a new one and set `VERCEL_TOKEN` again. A run without a token, or without either id, fails and names what is missing.

## Later, if you want Vercel to build from Git

Not set up, and not tried. It replaces the workflow, so do both of these first:

1. Set `MARKETING_DEPLOY_ENABLED` to `false`.
2. Confirm on a preview deployment that `/privacy` still redirects.

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
