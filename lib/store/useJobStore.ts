import { create } from 'zustand';
import type { Job } from '@/lib/database/schema';

interface JobStore {
  jobs: Job[];
  lastRefreshedAt: number | null;
  error: string | null;
  refreshActive: () => Promise<void>;
}

export const useJobStore = create<JobStore>((set) => ({
  jobs: [],
  lastRefreshedAt: null,
  error: null,
  async refreshActive() {
    try {
      const res = await fetch('/api/jobs/active');
      const body = await res.json();
      if (body.success) {
        set({ jobs: body.data, lastRefreshedAt: Date.now(), error: null });
      } else {
        set({ error: body.error ?? 'Request failed.' });
      }
    } catch {
      set({ error: 'Could not reach the server.' });
    }
  },
}));
