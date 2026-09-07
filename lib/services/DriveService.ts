import { OAuth2Client } from 'google-auth-library';
import { drive } from '@googleapis/drive';
import type { Readable } from 'stream';
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

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
}

const LIST_FIELDS = 'files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents)';
const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents';

// Escapes a single-quoted string for Drive's `q` query language — the only
// character that needs escaping inside a single-quoted q-string is the
// single quote itself, per Drive API's search-query syntax.
function escapeDriveQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
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

  async listFiles(folderId: string = 'root', query?: string): Promise<DriveFile[]> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      let q = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
      if (query && query.trim()) {
        q += ` and name contains '${escapeDriveQueryValue(query.trim())}'`;
      }
      const res = await client.files.list({
        q,
        fields: LIST_FIELDS,
        pageSize: 1000,
        orderBy: 'folder,name',
      });
      return (res.data.files ?? []) as DriveFile[];
    } catch (e) {
      console.error(`Failed to list Drive files for folder ${folderId}:`, e);
      throw e;
    }
  }

  async uploadFile(params: { name: string; mimeType: string; stream: Readable; parentFolderId: string }): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.create({
        requestBody: { name: params.name, parents: [params.parentFolderId] },
        media: { mimeType: params.mimeType, body: params.stream },
      }, {
        fields: FILE_FIELDS,
      });
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to upload ${params.name} to Drive:`, e);
      throw e;
    }
  }

  // Moves to Trash — recoverable for 30 days, matching Drive's own web UI
  // delete button. Never calls files.delete(), which is immediate and
  // permanent with no recovery — see this plan's Global Constraints.
  async trashFile(fileId: string): Promise<void> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      await client.files.update({ fileId, requestBody: { trashed: true } });
    } catch (e) {
      console.error(`Failed to trash Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async renameFile(fileId: string, newName: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.update(
        { fileId, requestBody: { name: newName } },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to rename Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async moveFile(fileId: string, newParentId: string, oldParentId: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.update(
        { fileId, addParents: newParentId, removeParents: oldParentId, requestBody: {} },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to move Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async createFolder(name: string, parentFolderId: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.create(
        { requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] } },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to create Drive folder ${name}:`, e);
      throw e;
    }
  }
}

export const driveService = new DriveServiceImpl();
