import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';
import { type ServiceAccount, getGoogleAccessToken } from './googleAuth';

const SOURCE = 'gdrive';
const BRIEFINGS_FOLDER_ID = '1hAtDKH9UEH7emABrZECfgwXpkWF7tUti';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Maps Drive MIME type → the export format we want
const EXPORT_FORMATS: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
};

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Main export ───────────────────────────────────────────────────────────────

export async function syncGdrive(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  let synced = 0;
  let failed = false;

  try {
    const serviceAccount: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const accessToken = await getGoogleAccessToken(serviceAccount, DRIVE_SCOPE);

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

