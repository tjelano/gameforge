'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface UserOption {
  id: string;
  name: string;
}

export function LoginForm({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loginAs(userId: string) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not log in.');
        return;
      }
      router.push('/dashboard/generate');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePull() {
    if (pulling) return;
    setPulling(true);
    setPullError(null);
    try {
      const res = await fetch('/api/git/pull', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setPullError(body.message ?? 'Pull failed — no git remote configured yet?');
        return;
      }
      setPulled(true);
      router.refresh();
    } finally {
      setPulling(false);
    }
  }

  async function handleCreateFirst(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not create your account.');
        return;
      }
      router.push('/dashboard/generate');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (users.length > 0) {
    return (
      <div>
        {users.map(u => (
          <button key={u.id} className="btn" style={{ display: 'block', width: '100%', marginBottom: 8 }} onClick={() => loginAs(u.id)} disabled={submitting}>
            {u.name}
          </button>
        ))}
        {error && <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p className="page-subtitle">No accounts found on this machine yet.</p>
      <button className="btn" onClick={handlePull} disabled={pulling} style={{ marginBottom: 16 }}>
        {pulling ? 'Pulling…' : 'Pull from git first'}
      </button>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{pullError} You can still create the first account below.</p>}
      {pulled && <p style={{ fontSize: 13, marginBottom: 16 }}>Pull finished — refreshing…</p>}

      <p className="page-subtitle">This is a brand new project — create the first account (this makes you the admin):</p>
      <form onSubmit={handleCreateFirst} style={{ display: 'flex', gap: 8 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
        <button className="btn btn-primary" type="submit" disabled={submitting || !newName.trim()}>
          Create
        </button>
      </form>
      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
