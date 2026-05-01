import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const SOURCE = 'policy_papers';
const INDEX_URL = 'https://www.libdems.org.uk/sandbox/policy-index';
const BASE_URL = 'https://www.libdems.org.uk';
const MAX_PAGES = 40;
const CRAWL_DELAY_MS = 300;

export async function syncPolicyPapers(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  let synced = 0;
  let failed = false;

  try {
    const indexRes = await fetch(INDEX_URL, {
      headers: { 'User-Agent': 'CPA-Policy-Bot/1.0' },
    });

    if (!indexRes.ok) {
      throw new Error(`Index fetch failed (${indexRes.status}): ${INDEX_URL}`);
    }

    const indexHtml = await indexRes.text();
    const links = extractPolicyLinks(indexHtml);
    console.log(`Policy papers: found ${links.length} links on index page`);

    for (const url of links) {
      await delay(CRAWL_DELAY_MS);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'CPA-Policy-Bot/1.0' },
        });

        if (!res.ok) {
          console.warn(`Policy paper fetch failed (${res.status}): ${url}`);
          continue;
        }

        const html = await res.text();
        const title = extractTitle(html) || url.split('/').pop() || 'Policy Paper';
        const content = extractText(html);

        if (!content.trim()) continue;

        const sourceId = new URL(url).pathname;

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: SOURCE,
            source_id: sourceId,
            title,
            content,
            url,
            last_updated: new Date().toISOString(),
            synced_at: new Date().toISOString(),
            metadata: {},
          },
          { onConflict: 'source,source_id' },
        );

        if (error) {
          console.error(`Upsert failed for ${url}:`, error.message);
        } else {
          synced++;
        }
      } catch (err) {
        console.warn(`Failed to process ${url}:`, err);
      }
    }
  } catch (err) {
    console.error('Policy papers sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`Policy papers sync complete — ${synced} pages upserted, failed=${failed}`);
}

function extractPolicyLinks(html: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const pattern = /href="(\/[^"?#\s]+)"/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const path = match[1];

    // Skip navigation, utility, and asset paths
    if (
      /^\/(search|login|account|logout|join|donate|news|events|press|media|about|contact|accessibility|cookies|privacy|terms|sitemap|feed|rss)($|\/)/.test(
        path,
      )
    )
      continue;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip)$/i.test(path)) continue;
    if (path === '/sandbox/policy-index' || path === '/') continue;

    const url = BASE_URL + path;
    if (!seen.has(url)) {
      seen.add(url);
      links.push(url);
    }

    if (links.length >= MAX_PAGES) break;
  }

  return links;
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
