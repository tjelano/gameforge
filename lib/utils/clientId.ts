// GameForge has no auth system (local-first, single-user by design) —
// created_by needs *some* stable identity for the "only the creator can
// edit" rule to mean anything across sessions. Persist a local id.
const STORAGE_KEY = 'gameforge-client-id';

export function getClientId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
