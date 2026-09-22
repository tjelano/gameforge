// Shared env-driven constants. Extracted here because both GitService
// (staging chunk size) and AssetService (cleanup delete-batch size) need
// the same IO_WRITE_BATCH_SIZE value.

export const IO_WRITE_BATCH_SIZE = Number(process.env.IO_WRITE_BATCH_SIZE) || 25;
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 5;

// Settings-table key for the Aseprite executable path. Shared between
// the settings API route and the asset edit route.
export const ASEPRITE_PATH_SETTING_KEY = 'aseprite_path';

// Settings-table key for the stored Google Drive OAuth refresh token.
// Shared between the OAuth callback route (writes it) and DriveService
// (reads it on every Drive API call).
export const GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY = 'google_drive_refresh_token';

// Settings-table key for the configured Ollama host, and its default when
// unset -- Ollama's own standard local port.
export const OLLAMA_HOST_SETTING_KEY = 'ollama_host';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

// Written by worker.ts's independent heartbeat timer (see WORKER_ALIVE_THRESHOLD_MS below) —
// on its own setInterval at the same cadence as the job-poll tick, NOT gated behind job
// processing. Read by GET /api/dashboard/worker-status to show a health indicator in the
// Overview page — nothing else consumes this key.
export const WORKER_LAST_SEEN_SETTING_KEY = 'worker_last_seen';

// worker.ts's own poll cadence -- single source of truth so the worker's timer and the
// dashboard's staleness threshold can't silently desync.
export const POLL_INTERVAL_MS = 2000;

// 3x POLL_INTERVAL_MS. A missed tick or two shouldn't flip the indicator to "not detected";
// three missed ticks in a row genuinely means the worker process isn't running.
export const WORKER_ALIVE_THRESHOLD_MS = 3 * POLL_INTERVAL_MS;
