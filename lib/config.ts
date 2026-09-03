// Shared env-driven constants. Extracted here because both GitService
// (staging chunk size) and AssetService (cleanup delete-batch size) need
// the same IO_WRITE_BATCH_SIZE value.

export const IO_WRITE_BATCH_SIZE = Number(process.env.IO_WRITE_BATCH_SIZE) || 25;
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 5;
