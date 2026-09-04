# GameForge

A local-first, git-native game asset pipeline. Define visual "Style Bibles," generate consistent 2D
assets via AI, fork styles into independent variations, and export to Godot (2D only for V1).

SQLite is the source of truth. Git is how the data (styles, assets, and their images) syncs and backs up
across machines — every style and asset is also written out as a UUID-named JSON file under `data/`, and
images are tracked via Git LFS.

## ⚠️ Not deployable to Vercel (or any serverless platform)

This is a local desktop tool, not a web app meant to be hosted. It depends on things serverless platforms
don't give you:

- A **local SQLite file** (`data.db`) as the source of truth — there's no managed database.
- A **separate long-running worker process** (`worker.ts`) that polls the database — serverless functions
  don't stay alive between requests.
- **Direct git operations** (`git add`/`commit`/`push`/`pull`) against the local filesystem's own `.git`
  — a serverless function has no persistent, writable git checkout.

Run it on your own machine. If you want it accessible from elsewhere, put it behind your own VPN or
tunnel — don't deploy it to Vercel, Netlify, or similar.

## Setup

```bash
./setup.sh      # macOS / Linux / WSL / Git Bash
setup.bat       # Windows (cmd)
```

This checks for `git`, initializes a repo if you haven't already, warns if there's no `origin` remote
configured yet (needed for Push/Pull to actually sync anywhere), creates `.env.local` from
`.env.local.example`, and installs dependencies.

Set `PIXELLAB_API_KEY` in `.env.local` for real generation (uses Pixellab's `create-image-pixflux`
endpoint). Without a key, generation falls back to `MockGenerator`, which writes a placeholder image so
the rest of the pipeline (review, promote, export) is still fully exercisable.

Set `ANTHROPIC_API_KEY` in `.env.local` to enable real website theme generation. Without a key, generation
falls back to `MockThemeGenerator`, which writes a fixed token set so the rest of the pipeline stays
exercisable.

Instead of the official Anthropic API, theme generation can also run through cheaperinference.com or
kie.ai — set `THEME_API_PROVIDER` to `cheaperinference` or `kieai` and provide the matching
`CHEAPERINFERENCE_API_KEY` or `KIEAI_API_KEY`. Leaving `THEME_API_PROVIDER` unset keeps the
`ANTHROPIC_API_KEY`-or-mock behavior above unchanged. An explicitly-selected provider whose key is missing
fails with a clear error rather than silently falling back to the mock.

**If you're running the worker separately** (`npm run dev:worker`, not through `next dev`), env vars only
reach it because that script explicitly passes `--env-file-if-exists=.env.local` — a bare `tsx worker.ts`
does not load `.env.local` on its own the way `next dev` does. If you ever invoke the worker a different
way, keep that flag or the key silently won't be seen and it'll fall back to the mock with no error.

## Running it

You need **two processes** running at once:

```bash
npm run dev          # the Next.js dashboard, at http://localhost:3000
npm run dev:worker    # the background job worker
```

The dashboard queues generation jobs; the worker is what actually claims and processes them. Nothing
generates if only `npm run dev` is running.

## The pipeline

1. **Style Bibles** — define a visual style. Only its creator can edit it; anyone else forks it into an
   independent copy with a new id (the original is never modified).
2. **Generate** — queue a prompt against a style. The worker picks it up, generates an image, and the job
   moves to `complete`.
3. **Jobs** — review what came back. **Promote** a keeper into a permanent asset, **Discard** a reject, or
   **Retry** a failed generation.
4. **Storage → Clean Up Orphaned Images** — on-demand cleanup of image files nothing references anymore.
   Nothing is deleted automatically; run it whenever you want to reclaim disk space.
5. **Export** — copy every active asset's image into a target folder for your Godot project (2D only for
   V1).

## Syncing across machines

Push and Pull operate on the same git repo as your own commits, but only ever stage `data/` (the JSON
mirror of styles and assets) plus the images belonging to active assets — never your app source. Pull
saves any local changes first (so nothing is silently lost), then merges. If a merge conflict happens,
resolve it in `data/styles/` / `data/assets/` by hand and hit **Resolve** — it refuses to commit if any
conflict markers are still present in the files.

## Development

```bash
npm test         # Vitest — migrations, git-sync logic, and API routes all run against real
                  # SQLite files and real (temporary) git repos, not mocks
npm run typecheck
npm run lint
```

See `AGENTS.md` for the project's own rules for AI-assisted changes (forbidden patterns, required
conventions) — `CLAUDE.md` and `.cursorrules` both point back to it.
