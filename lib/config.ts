// Shared env-driven constants. Extracted here because both GitService
// (staging chunk size) and AssetService (cleanup delete-batch size) need
// the same IO_WRITE_BATCH_SIZE value.

export const IO_WRITE_BATCH_SIZE = Number(process.env.IO_WRITE_BATCH_SIZE) || 25;
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 5;

// Settings-table key for the Aseprite executable path. Shared between
// the settings API route and the asset edit route.
export const ASEPRITE_PATH_SETTING_KEY = 'aseprite_path';
