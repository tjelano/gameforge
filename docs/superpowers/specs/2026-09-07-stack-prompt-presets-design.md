# Stack/Prompt Presets — Design

**Status:** Approved by user, pending spec review.
**Item 4 of the GameForge workflow backlog.**

## Problem

Every generation today starts from a blank prompt. There's no way to save
"here's the prompt template, tech-stack labels, and set of components I use
for this kind of project" and reuse it when starting something new — the
user's own framing: "options to select prompt/tools/techstack to make it
all easier to get a functioning website... to prevent having to repeat
yourself when trying to setup/create a website."

## Explicit non-goals (scope, confirmed with user)

- **Tech-stack tags do not change generation output.** They are free-text
  organizational labels only ("Tailwind", "React", "SaaS"). A real
  React/JSX + Tailwind component output *format* was raised during
  brainstorming and explicitly split out as a separate, future, not-yet-
  designed backlog item — it needs a fundamentally different safety model
  than today's HTML+CSS sanitization pipeline (JSX is executable code, not
  markup; there's no equivalent allowlist to sanitize it against). Do not
  conflate the two.
- **No per-owner editing restriction on presets.** Matches jobs/assets
  (shared, anyone can edit/delete), not Style Bibles' owner-only-edit +
  fork model. Confirmed directly with the user.
- **No candidate-count selection when applying a preset.** Every item in a
  preset generates exactly 1 candidate. Themes could technically request
  3/5, but presets are about getting a fast starting point, not comparing
  candidates — the user can always generate more of any one piece
  afterward through the normal Themes/Components pages.

## Data model

New table, migration `012_add_presets.sql`:

```sql
CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  prompt TEXT NOT NULL,
  tech_stack_tags TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  theme_prompt TEXT,                             -- nullable
  components TEXT NOT NULL DEFAULT '[]',         -- JSON array of {assetType, prompt}
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Zod schema (`lib/database/schema.ts`), mirroring `StyleSchema`'s shape:

```ts
export const PresetComponentSchema = z.object({
  assetType: z.string().min(1),
  prompt: z.string().min(1),
});
export type PresetComponent = z.infer<typeof PresetComponentSchema>;

export const PresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  prompt: z.string().min(1),
  tech_stack_tags: z.string(),   // JSON-serialized string[], parsed by callers
  theme_prompt: z.string().nullable(),
  components: z.string(),        // JSON-serialized PresetComponent[], parsed by callers
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;
```

`tech_stack_tags` and `components` are stored as JSON strings, same
established convention as `styles.parameters` and `jobs.options` — parsed
client-side / at the API boundary, never queried into by SQL.

**`components` is a wishlist, not a reference to existing assets.** Each
entry is a `{assetType, prompt}` pair describing something to *generate*
when the preset is applied — it holds no asset id, no image_path, nothing
that ties it to any already-generated file. This is deliberate: presets
exist to scaffold a *new* Style Bible's starting set, not to link to
another bible's actual output.

**`prompt` (top-level) vs `theme_prompt` vs each component's own `prompt`:**
top-level `prompt` is the preset's own descriptive base text (e.g.
"minimalist SaaS landing page, dark mode, generous whitespace") — shown in
the presets list, editable, but not directly sent to a generator on its
own. `theme_prompt` and each component's `prompt` are the actual per-item
generation prompts sent to `jobService`. In the manual creation form,
`theme_prompt` and component prompts default to `<base prompt> + <item
description>` (e.g. base prompt + "nav bar") but are independently
editable — this avoids a component's own prompt formula living in the UI
layer.

## Service layer

`lib/services/PresetService.ts`, mirroring `StyleService.ts`'s shape:

- `getActivePresets(): Promise<Preset[]>`
- `getById(id): Promise<Preset | null>`
- `create(input): Promise<Preset>`
- `update(id, patch): Promise<Preset | null>` — no ownership check (see
  non-goals above)
- `softDelete(id): Promise<void>`

## API routes

- `GET /api/presets` — list active presets (no auth required, matches
  `GET /api/styles`/`GET /api/assets` convention).
- `POST /api/presets` — create (requires login, matches every other
  mutating route in this app).
- `GET /api/presets/[id]` — one preset.
- `PUT /api/presets/[id]` — update (requires login, no ownership check).
- `DELETE /api/presets/[id]` — soft-delete (requires login, no ownership
  check).
- `POST /api/presets/[id]/apply` — the batch-generation endpoint. Body:
  `{ newStyleName?: string, existingStyleId?: string }` (exactly one
  required — Zod `.refine()`). Requires login.

### Apply endpoint — atomicity

The whole operation (create the Style Bible if `newStyleName` was given,
create one job per preset item, stamp every created job with one shared
`batch_id`) runs inside a single **synchronous `db.transaction()`** — not
the existing async service methods, since `better-sqlite3` transaction
callbacks must be synchronous. This is a deliberate deviation from the
existing (accepted, lower-stakes) multi-candidate loop in
`app/api/generate/route.ts`, which has no transaction and can leave
orphaned jobs on a mid-loop failure — acceptable there (extra candidates
for an already-existing style), not acceptable here (creating a new Style
Bible and several jobs as one logical unit — a mid-loop failure should
roll back the whole thing, not leave a half-populated new bible).

Pseudocode (illustrative — the plan will write this out fully with exact
SQL, matching every other service's direct-SQL convention):

```ts
const applyPreset = db.transaction((preset: Preset, target: { styleId: string }) => {
  const batchId = crypto.randomUUID();
  const items: { assetType: string; prompt: string; outputKind: 'theme' | 'component' }[] = [];
  if (preset.theme_prompt) {
    items.push({ assetType: 'theme', prompt: preset.theme_prompt, outputKind: 'theme' });
  }
  for (const c of JSON.parse(preset.components) as PresetComponent[]) {
    items.push({ assetType: c.assetType, prompt: c.prompt, outputKind: 'component' });
  }
  const createdJobIds: string[] = [];
  for (const item of items) {
    const jobId = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, '{}', ?, ?)
    `).run(jobId, target.styleId, /* createdBy */ '', item.assetType, item.prompt, now, now, item.outputKind, batchId);
    createdJobIds.push(jobId);
  }
  return { batchId, jobIds: createdJobIds };
});
```

If `newStyleName` was given, the style INSERT happens inside the same
transaction, before the jobs loop, using the id it generates as
`target.styleId`.

**Edge case, resolved:** a preset with `theme_prompt: null` and an empty
`components` array is a valid (if useless) preset — the apply endpoint
returns a 400 ("This preset has nothing to generate") rather than silently
creating a style with zero jobs.

## Dedup/similarity route — one small fix bundled in

`app/api/jobs/[id]/similarity/route.ts`'s sibling-comparison loop
(`jobService.getByBatchId(job.batch_id)`) currently iterates every sibling
in a batch without filtering by kind. This was never a problem before
because every existing batch was homogeneous (multi-candidate = same
kind repeated); preset-applied batches are the first heterogeneous batches
this app will ever create. The loop already degrades safely on a
non-theme sibling (path guard + try/catch → skip), but silently attempting
to parse a component's HTML file as theme CSS on every check is wasted
work and log noise. Fix: filter siblings to `output_kind === 'theme'`
before the loop.

## UI

### `/dashboard/presets` (new nav entry, added to `NavRail.tsx`)

- List of active presets (name, tags, component count) — mirrors the
  Style Bibles page's card-grid pattern.
- "New Preset" form: name, prompt, tags (comma-separated text input,
  split/trimmed client-side), optional theme prompt, repeatable
  "add component" rows (type + prompt, prefilled from `<preset prompt> +
  <type>` when the type is entered, independently editable).
- Each card: "Apply" button → small modal, choose "Create new Style Bible"
  (name field) or pick from existing active styles (reuses `useStyles()`)
  → submit → redirect to the new/target Style Bible's Hub page
  (`/dashboard/styles/[id]`), where the newly queued jobs are visible via
  the existing Jobs-queue-on-the-Hub-page... **correction, checked**: the
  Hub page (shipped in PR #14) shows *promoted assets*, not in-flight
  jobs — it has no jobs section. Redirect to `/dashboard/jobs` instead,
  where the existing `getActive()`-polling queue already shows all
  `pending`/`processing` jobs regardless of style, batch, or kind — no
  changes needed there.
- Edit/Delete on each preset card (no ownership gating, per non-goals).

### "Save as preset" button on the Style Bible Hub page

Reads the Hub's already-fetched assets list, pre-fills the New Preset form
with: the most recently promoted theme asset's `prompt` as `theme_prompt`
(if any), and every promoted component asset's `{asset_type, prompt}` as
the `components` list. Opens the same form as the Presets page's "New
Preset" (implemented as a shared component to avoid duplicating the form),
navigated to `/dashboard/presets?prefillFromStyle=<id>` or an equivalent
mechanism — exact wiring decided at plan time.

## Testing approach

- `PresetService` and the transaction-based apply logic: real temporary
  SQLite DB tests, matching every other DB-touching service in this
  codebase (`setProjectRootForTests` + `DatabaseConnection.resetForTests`).
  Specifically test: apply-to-new-style creates exactly the right number
  of jobs with the right `output_kind`s and a shared `batch_id`;
  apply-to-existing-style does not create a new style row;
  apply-with-nothing-to-generate returns 400 and creates nothing (real
  DB assertion, not just an HTTP status check); a forced mid-loop failure
  (e.g. a malformed `components` JSON string) rolls back the transaction —
  no partial style/job rows survive.
- Route-level tests: `NextRequest`/session-cookie pattern already
  established (`test/helpers/testSession.ts`).
- Similarity-route fix: extend the existing similarity route's test file
  with a case asserting a non-theme sibling in the same batch is skipped
  without a parse attempt (or at minimum without flipping `flagged`).

## Migration numbering

Next available migration is `012_add_presets.sql` — confirmed by reading
`lib/database/migrations/` directly (`011_add_users_and_sessions.sql` is
the last one currently in the repo), not assumed from memory.
