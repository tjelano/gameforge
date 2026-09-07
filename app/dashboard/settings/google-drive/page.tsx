'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function GoogleDriveSettingsContent() {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/drive/status');
        const body = await res.json();
        if (!ignore && body.success) setConnected(body.data.connected);
      } catch {
        if (!ignore) setConnected(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <>
      <h1 className="page-title">Google Drive</h1>
      <p className="page-subtitle">
        Connect the Google account that owns the shared Drive — everyone using GameForge browses
        and shares through this one connection.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        {connected === null ? (
          <p className="page-subtitle">Loading…</p>
        ) : (
          <>
            <p style={{ marginBottom: 12 }}>
              Status: {connected ? 'Connected' : 'Not connected'}
            </p>
            <a className="btn btn-primary" href="/api/drive/connect">
              {connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
            </a>
          </>
        )}
        {oauthError && (
          <p style={{ marginTop: 14, fontSize: 13, color: 'var(--reject)' }}>
            Connection failed: {oauthError}
          </p>
        )}
      </div>
    </>
  );
}

export default function GoogleDriveSettingsPage() {
  return (
    <Suspense fallback={<p className="page-subtitle">Loading…</p>}>
      <GoogleDriveSettingsContent />
    </Suspense>
  );
}
