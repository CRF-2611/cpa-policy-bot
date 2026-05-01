import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const SOURCE = 'manifesto';
const MANIFESTO_URL = 'https://www.libdems.org.uk/manifesto';
const SOURCE_ID = 'ld-manifesto-2024';

export async function syncManifesto(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  let failed = false;

  try {
    const res = await fetch(MANIFESTO_URL, {
      headers: { 'User-Agent': 'CPA-Policy-Bot/1.0' },
    });

    if (!res.ok) {
      throw new Error(`Fetch failed (${res.status}): ${MANIFESTO_URL}`);
    }

    const html = await res.text();
    const title = extractTitle(html) || 'Liberal Democrat Manifesto 2024';
    const content = extractText(html);

    if (!content.trim()) {
      throw new Error('Extracted empty content from manifesto page');
    }

    const { error } = await supabase.from('policy_content').upsert(
      {
        source: SOURCE,
        source_id: SOURCE_ID,
        title,
        content,
        url: MANIFESTO_URL,
        last_updated: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        metadata: {},
      },
      { onConflict: 'source,source_id' },
    );

    if (error) throw new Error(`Upsert failed: ${error.message}`);

    console.log(`Manifesto sync complete — ${content.length} chars`);
  } catch (err) {
    console.error('Manifesto sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: failed ? 0 : 1,
  });
}

function extractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) return title[1].replace(/\s*[|–-].*$/, '').trim();
  return '';
}

function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|tr|div|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
