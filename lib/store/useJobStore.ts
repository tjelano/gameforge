import { create } from 'zustand';
import type { Job } from '@/lib/database/schema';

interface JobStore {
  jobs: Job[];
  lastRefreshedAt: number | null;
  refreshActive: () => Promise<void>;
}

export const useJobStore = create<JobStore>((set) => ({
  jobs: [],
  lastRefreshedAt: null,
  async refreshActive() {
    const res = await fetch('/api/jobs/active');
    const body = await res.json();
    if (body.success) {
      set({ jobs: body.data, lastRefreshedAt: Date.now() });
    }
  },
}));
