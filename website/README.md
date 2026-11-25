# NoMouse project site

The project site for NoMouse (CICS 256, Fall 2026): a wireless hand strap that turns hand gestures into cursor movement and clicks over Bluetooth.

Built with Vite, React and TanStack Router. It's deployed to GitHub Pages at `https://<github-user>.github.io/no-mouse/`.

## Run it

```bash
cd website
npm install
npm run dev        # http://localhost:5173/no-mouse/
npm run build      # production build + type check → dist/
npm run preview    # serve the production build locally
```

## Where the content lives

Most updates are a data edit, with no component changes:

| What | File |
| --- | --- |
| Tagline, pitch, project description, course info | `src/data/site.ts` |
| Hardware list and statuses (`have` / `ordered` / `unknown`) | `src/data/hardware.ts` (also bump `hardwareUpdated`) |
| Timeline milestones and task checkboxes | `src/data/timeline.ts` |
| Team members, roles, photos, links | `src/data/team.ts` |
| Progress notes | `src/data/notes.ts` |

Images and other media go in `public/`. Reference them by their path inside `public/`, e.g. `images/prototype-breadboard.jpg`. Shrink photos before adding them; about 1600 px wide is plenty.

### Adding a progress note

Add an entry to the `notes` array in `src/data/notes.ts`. The file's top comment has a full template. A note has a `slug` (its URL), `title`, `date` (`YYYY-MM-DD`), `author` (a team id such as `'hue'`, or a list), `tags`, and an ordered list of `blocks`:

- `text`: paragraphs, `**bold**`, `*italic*`, `` `code` ``, `[links](url)`, lists (lines starting with `-`), headings (`##`)
- `image`: `src`, `alt`, optional `caption` and `wide`
- `gif`: `src`, `alt`, optional `caption`
- `video`: either `youtube` (a URL or ID) or `src` (a file in `public/`, optional `poster`)
- `gallery`: `images: [{ src, alt, caption? }, …]`
- `callout`: `text`, optional `title` and `tone` (`note`, `win`, `problem`)

The feed sorts newest first. Each note gets its own page at `/notes/<slug>`. Put `draft: true` on a note to see it in `npm run dev` without publishing it.

## Structure

```text
assets/                 original photos and screenshots (source material, not served; put resized copies in public/)
public/                 files served as-is: favicon, images, note media
src/
  routes/               one file per page (TanStack file routes); __root.tsx holds the nav, footer and backdrop
  components/site/      shared components: hand illustration, diagrams, timeline, notes block renderers, …
  data/                 all site content
  hooks/                scroll CSS variables + reveal-on-scroll
  styles.css            design tokens (oklch), components and animations
```

Scroll effects read two CSS variables that `useScrollVars` sets on `<html>`: `--sy` (scroll position) and `--progress` (0–1). Looping animations are CSS keyframes. All of them switch off under `prefers-reduced-motion`.

## Deploying

`.github/workflows/deploy-site.yml` builds `website/` and publishes it to GitHub Pages on every push to `main` that touches `website/`. It can also be run by hand from the Actions tab.

One-time setup: in the repo on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

The site is built for the `/no-mouse/` path. If the repo is renamed or hosted elsewhere, build with `BASE_PATH=/new-path/ npm run build`.
