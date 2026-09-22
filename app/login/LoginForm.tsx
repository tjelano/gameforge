'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface UserOption {
  id: string;
  name: string;
}

export function LoginForm({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const expired = searchParams.get('reason') === 'expired';
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);

  const expiredBanner = expired && (
    <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
      Your session expired — pick your name again.
    </p>
  );

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
        setPullError(body.error ?? body.message ?? 'Pull failed — no git remote configured yet?');
        return;
      }
      setPulled(true);
      // Land back on the (now-refreshed) account list instead of leaving the
      // create form mounted and submittable -- otherwise a successful pull
      // that brings in the account the user was looking for still lets them
      // click Create and make a duplicate without ever seeing the updated list.
      setAddingAccount(false);
      router.refresh();
    } finally {
      setPulling(false);
    }
  }

  async function handleCreateAccount(e: React.FormEvent, force: boolean) {
    e.preventDefault();
    if (!newName.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), force }),
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

  function createAccountForm(force: boolean) {
    return (
      <>
        <form onSubmit={e => handleCreateAccount(e, force)} style={{ display: 'flex', gap: 8 }}>
          <label htmlFor="newAccountName" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Your name</label>
          <input id="newAccountName" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
          <button className="btn btn-primary" type="submit" disabled={submitting || !newName.trim()}>
            Create
          </button>
        </form>
        {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{error}</p>}
      </>
    );
  }

  if (users.length > 0) {
    return (
      <div>
        {expiredBanner}
        {users.map(u => (
          <button key={u.id} className="btn" style={{ display: 'block', width: '100%', marginBottom: 8 }} onClick={() => loginAs(u.id)} disabled={submitting}>
            {u.name}
          </button>
        ))}
        {!expired && !addingAccount && (
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => { setError(null); setAddingAccount(true); }}>
            + Add another account
          </button>
        )}
        {addingAccount && (
          <div style={{ marginTop: 12 }}>
            <p className="page-subtitle">
              If another account was created elsewhere and hasn&apos;t synced here yet, pull first —
              otherwise create a new account below.
            </p>
            <button className="btn" onClick={handlePull} disabled={pulling} style={{ marginBottom: 12 }}>
              {pulling ? 'Pulling…' : 'Pull from git first'}
            </button>
            {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{pullError} You can still create the account below.</p>}
            {createAccountForm(true)}
          </div>
        )}
        {!addingAccount && error && <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {expiredBanner}
      <p className="page-subtitle">No accounts found on this machine yet.</p>
      <button className="btn" onClick={handlePull} disabled={pulling} style={{ marginBottom: 16 }}>
        {pulling ? 'Pulling…' : 'Pull from git first'}
      </button>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{pullError} You can still create the first account below.</p>}
      {pulled && <p style={{ fontSize: 13, marginBottom: 16 }}>Pull finished — refreshing…</p>}

      <p className="page-subtitle">This is a brand new project — create the first account (this makes you the admin):</p>
      {createAccountForm(false)}
    </div>
  );
}
