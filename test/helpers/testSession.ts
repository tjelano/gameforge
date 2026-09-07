import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

export async function seedSession(name = 'Test User'): Promise<{ userId: string; cookieHeader: string }> {
  const user = await userService.create({ name });
  const { token } = await sessionService.create(user.id);
  return { userId: user.id, cookieHeader: `session=${token}` };
}
