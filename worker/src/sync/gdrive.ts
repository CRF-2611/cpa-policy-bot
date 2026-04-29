import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const SOURCE = 'gdrive';
const BRIEFINGS_FOLDER_ID = '1hAtDKH9UEH7emABrZECfgwXpkWF7tUti';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Maps Drive MIME type → the export format we want
const EXPORT_FORMATS: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

interface TokenResponse {
  access_token: string;
  error?: string;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function syncGdrive(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  let synced = 0;
  let failed = false;

  try {
    const serviceAccount: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const accessToken = await getAccessToken(serviceAccount);

    // Recursively collect all exportable files under the briefings folder
    const files = await collectFolderFiles(BRIEFINGS_FOLDER_ID, accessToken);
    console.log(`GDrive: found ${files.length} exportable files`);

    for (const file of files) {
      const content = await exportContent(file, accessToken);
      if (content === null) continue; // export failed — skip, don't upsert empty

      const { error } = await supabase.from('policy_content').upsert(
        {
          source: SOURCE,
          source_id: file.id,
          title: file.name,
          content,
          url: file.webViewLink ?? null,
          last_updated: file.modifiedTime,
          synced_at: new Date().toISOString(),
          metadata: { mime_type: file.mimeType },
        },
        { onConflict: 'source,source_id' },
      );

      if (error) {
        console.error(`Upsert failed for ${file.id} (${file.name}):`, error.message);
      } else {
        synced++;
      }
    }
  } catch (err) {
    console.error('GDrive sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`GDrive sync complete — ${synced} files upserted, failed=${failed}`);
}

// ── Folder traversal ──────────────────────────────────────────────────────────

/**
 * Returns all exportable files in folderId and any subfolders (depth-first).
 * Handles Drive's 100-item page limit at every level.
 */
async function collectFolderFiles(
  folderId: string,
  token: string,
  depth = 0,
): Promise<DriveFile[]> {
  // Guard against deeply nested or circular folder structures
  if (depth > 5) return [];

  const files: DriveFile[] = [];
  const subfolderIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
      // Scope to this specific folder only; trashed=false excludes deleted files
      q: `'${folderId}' in parents and trashed=false`,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_BASE}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive files.list failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as DriveFileList;

    for (const item of data.files) {
      if (item.mimeType === FOLDER_MIME) {
        subfolderIds.push(item.id);
      } else if (item.mimeType in EXPORT_FORMATS) {
        files.push(item);
      }
      // Other MIME types (PDFs, images, etc.) are skipped
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  // Recurse into subfolders sequentially to avoid flooding the Drive API
  for (const subfolderId of subfolderIds) {
    const subFiles = await collectFolderFiles(subfolderId, token, depth + 1);
    files.push(...subFiles);
  }

  return files;
}

// ── Content export ────────────────────────────────────────────────────────────

/**
 * Exports a Google Workspace file as plain text or CSV.
 * Returns null if the export fails (caller skips the upsert).
 */
async function exportContent(file: DriveFile, token: string): Promise<string | null> {
  const exportMime = EXPORT_FORMATS[file.mimeType];
  if (!exportMime) return null;

  const res = await fetch(
    `${DRIVE_BASE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    console.error(`Export failed for "${file.name}" (${file.id}): ${res.status}`);
    return null;
  }

  return res.text();
}

// ── Google OAuth2 — JWT bearer flow ──────────────────────────────────────────

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const jwt = await buildServiceAccountJwt(account);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = (await res.json()) as TokenResponse;

  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${data.error ?? 'unknown'}`);
  }

  return data.access_token;
}

/**
 * Builds a signed RS256 JWT for the service-account bearer flow.
 * Uses WebCrypto (available in Cloudflare Workers) — no Node.js crypto.
 */
async function buildServiceAccountJwt(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: account.client_email,
    sub: account.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // Strip PEM envelope and decode the PKCS#8 DER bytes
  const pemBody = account.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlBytes(new Uint8Array(sigBuffer))}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Base64url-encodes a UTF-8 string. */
function b64url(str: string): string {
  return b64urlBytes(new TextEncoder().encode(str));
}

/** Base64url-encodes a byte array without stack-blowing spread. */
function b64urlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
