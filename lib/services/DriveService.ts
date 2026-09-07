import { OAuth2Client } from 'google-auth-library';
import { settingsService } from '@/lib/services/SettingsService';
import { GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY } from '@/lib/config';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const REDIRECT_PATH = '/api/drive/callback';

function baseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

function newOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl()}${REDIRECT_PATH}`
  );
}

class DriveServiceImpl {
  async isConnected(): Promise<boolean> {
    const token = await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY);
    return !!token;
  }

  getAuthUrl(): string {
    const client = newOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_SCOPE],
    });
  }

  async exchangeCodeForTokens(code: string): Promise<void> {
    const client = newOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Reconnect and make sure to approve access when prompted.');
    }
    await settingsService.set(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY, tokens.refresh_token);
  }

  // Every Drive-API-calling method below (Tasks 3-6) calls this first.
  private async getAuthedClient(): Promise<OAuth2Client> {
    const refreshToken = await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY);
    if (!refreshToken) {
      throw new Error('Google Drive is not connected. Visit Settings > Google Drive to connect.');
    }
    const client = newOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }
}

export const driveService = new DriveServiceImpl();
