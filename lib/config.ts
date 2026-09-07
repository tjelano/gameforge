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
