import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';
import { type ServiceAccount, getGoogleAccessToken } from './googleAuth';

const SOURCE = 'rolling_top_lines';
const DOC_ID = '1VVIfo4wl5TTxC_Laemh8SpNHL_rlk7cCEYXoB_gH-2g';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;

export async function syncRollingTopLines(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  let failed = false;

  try {
    const content = await fetchDocContent(env);

    if (!content.trim()) {
      throw new Error('Extracted empty content from rolling top lines document');
    }

    const { error } = await supabase.from('policy_content').upsert(
      {
        source: SOURCE,
        source_id: DOC_ID,
        title: 'Rolling Top Lines',
        content,
        url: DOC_URL,
        last_updated: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        metadata: { doc_id: DOC_ID },
      },
      { onConflict: 'source,source_id' },
    );

    if (error) throw new Error(`Upsert failed: ${error.message}`);

    console.log(`Rolling top lines sync complete — ${content.length} chars`);
  } catch (err) {
    console.error('Rolling top lines sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: failed ? 0 : 1,
  });
}

async function fetchDocContent(env: Env): Promise<string> {
  // Try public export first (works if doc is shared publicly)
  const publicUrl = `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`;
  const publicRes = await fetch(publicUrl, {
    headers: { 'User-Agent': 'CPA-Policy-Bot/1.0' },
    redirect: 'follow',
  });

  if (publicRes.ok) {
    const text = await publicRes.text();
    if (text.trim()) return text;
  }

  // Fall back to Drive API with service account auth
  const serviceAccount: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const accessToken = await getGoogleAccessToken(serviceAccount, DRIVE_SCOPE);

  const exportRes = await fetch(
    `${DRIVE_BASE}/files/${DOC_ID}/export?mimeType=${encodeURIComponent('text/plain')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!exportRes.ok) {
    const text = await exportRes.text();
    throw new Error(`Drive export failed (${exportRes.status}): ${text}`);
  }

  return exportRes.text();
}
