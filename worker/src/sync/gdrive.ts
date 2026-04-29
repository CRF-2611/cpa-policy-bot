import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const SOURCE = 'gdrive';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
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
}

export async function syncGdrive(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const serviceAccount: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const accessToken = await getAccessToken(serviceAccount);

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: 'in_progress',
    records_updated: 0,
  });

  let pageToken: string | undefined;
  let synced = 0;
  let failed = false;

  try {
    do {
      const params = new URLSearchParams({
        pageSize: '100',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
        q: "trashed=false and (mimeType='application/vnd.google-apps.document' or mimeType='application/pdf')",
        orderBy: 'modifiedTime desc',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        console.error('Drive API error:', res.status, await res.text());
        failed = true;
        break;
      }

      const data = (await res.json()) as DriveFileList;

      for (const file of data.files) {
        const content = await exportContent(file, accessToken);
        if (!content) continue;

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

        if (error) console.error('Supabase upsert error:', error.message);
        else synced++;
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error('GDrive sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`Google Drive sync complete: ${synced} files upserted`);
}

async function exportContent(file: DriveFile, token: string): Promise<string> {
  // Only Google Docs can be exported as plain text
  if (file.mimeType !== 'application/vnd.google-apps.document') return '';

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    console.error(`Export failed for ${file.id}:`, res.status);
    return '';
  }
  return res.text();
}

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const jwt = await buildJwt(account);
  const res = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

async function buildJwt(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: account.token_uri,
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  const pemBody = account.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

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

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signingInput}.${sig}`;
}
