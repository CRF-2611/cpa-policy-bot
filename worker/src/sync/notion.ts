import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';
const SOURCE = 'notion';

interface NotionRichText {
  plain_text: string;
}

interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  url?: string | null;
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
}

export async function syncNotion(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: 'in_progress',
    records_updated: 0,
  });

  let cursor: string | undefined;
  let synced = 0;
  let failed = false;

  try {
    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { value: 'page', property: 'object' },
      };
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`${NOTION_BASE}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        console.error('Notion search error:', res.status, await res.text());
        failed = true;
        break;
      }

      const data = (await res.json()) as NotionSearchResponse;

      for (const page of data.results) {
        const content = await fetchPageContent(page.id, headers);
        const title = extractTitle(page.properties);
        const topic = extractSelect(page.properties, 'Topic') ?? extractSelect(page.properties, 'Category');
        const tags = extractMultiSelect(page.properties, 'Tags');

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: SOURCE,
            source_id: page.id,
            title,
            content,
            url: page.url,
            last_updated: page.last_edited_time,
            synced_at: new Date().toISOString(),
            metadata: { topic, tags },
          },
          { onConflict: 'source,source_id' },
        );

        if (error) console.error('Supabase upsert error:', error.message);
        else synced++;
      }

      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error('Notion sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: SOURCE,
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`Notion sync complete: ${synced} pages upserted`);
}

async function fetchPageContent(
  pageId: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${NOTION_BASE}/blocks/${pageId}/children?page_size=100`, { headers });
  if (!res.ok) return '';
  const data = (await res.json()) as NotionBlocksResponse;
  return blocksToText(data.results);
}

function blocksToText(blocks: NotionBlock[]): string {
  return blocks
    .map(block => {
      const blockData = block[block.type] as Record<string, unknown> | undefined;
      if (!blockData) return '';
      const richText = blockData.rich_text as NotionRichText[] | undefined;
      return richText ? richText.map(t => t.plain_text).join('') : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractTitle(props: Record<string, NotionProperty>): string {
  for (const prop of Object.values(props)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map(t => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

function extractSelect(props: Record<string, NotionProperty>, key: string): string | null {
  return props[key]?.select?.name ?? null;
}

function extractMultiSelect(props: Record<string, NotionProperty>, key: string): string[] {
  return props[key]?.multi_select?.map(s => s.name) ?? [];
}
