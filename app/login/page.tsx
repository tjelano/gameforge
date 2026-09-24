import { Suspense } from 'react';
import { userService } from '@/lib/services/UserService';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const users = await userService.getAll();
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1 className="page-title">Who are you?</h1>
      <Suspense fallback={null}>
        <LoginForm users={users.map(u => ({ id: u.id, name: u.name }))} />
      </Suspense>
    </div>
  );
}
