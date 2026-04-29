import { createClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const SOURCE = 'notion';

// Block types that carry a rich_text array directly
const RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
]);

// ── Notion API types ──────────────────────────────────────────────────────────

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
  date?: { start: string; end: string | null } | null;
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionSearchResponse {
  object: string;
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function syncNotion(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };

  let synced = 0;
  let failed = false;

  try {
    // Paginate through all pages accessible to this integration
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { property: 'object', value: 'page' },
      };
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`${NOTION_BASE}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`Notion search failed (${res.status}):`, text);
        failed = true;
        break;
      }

      const data = (await res.json()) as NotionSearchResponse;

      for (const page of data.results) {
        // Fetch all block content, including nested children
        const content = await fetchFullPageContent(page.id, headers);
        const title = extractTitle(page.properties);
        const topic =
          extractSelect(page.properties, 'Topic') ??
          extractSelect(page.properties, 'Category') ??
          null;
        const tags = extractMultiSelect(page.properties, 'Tags');
        const status = extractSelect(page.properties, 'Status');

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: SOURCE,
            source_id: page.id,
            title,
            content,
            url: page.url,
            last_updated: page.last_edited_time,
            synced_at: new Date().toISOString(),
            metadata: { topic, tags, status },
          },
          { onConflict: 'source,source_id' },
        );

        if (error) {
          console.error(`Upsert failed for page ${page.id}:`, error.message);
        } else {
          synced++;
        }
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

  console.log(`Notion sync complete — ${synced} pages upserted, failed=${failed}`);
}

// ── Block content fetching ────────────────────────────────────────────────────

/**
 * Fetches all blocks for a page (handling pagination) then recursively
 * fetches children of any block that has_children. Returns plain text.
 */
async function fetchFullPageContent(
  pageId: string,
  headers: Record<string, string>,
  depth = 0,
): Promise<string> {
  // Avoid runaway recursion on pathologically nested pages
  if (depth > 3) return '';

  const blocks = await fetchAllBlocks(pageId, headers);
  const parts: string[] = [];

  for (const block of blocks) {
    const text = extractBlockText(block);
    if (text) parts.push(text);

    // Recurse into child blocks (toggles, columns, synced blocks, etc.)
    if (block.has_children) {
      const childText = await fetchFullPageContent(block.id, headers, depth + 1);
      if (childText) parts.push(childText);
    }
  }

  return parts.join('\n');
}

/** Fetches every block under a parent ID, handling Notion's 100-item page limit. */
async function fetchAllBlocks(
  parentId: string,
  headers: Record<string, string>,
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);

    const res = await fetch(`${NOTION_BASE}/blocks/${parentId}/children?${params}`, { headers });
    if (!res.ok) {
      console.error(`blocks/${parentId}/children failed (${res.status})`);
      break;
    }

    const data = (await res.json()) as NotionBlocksResponse;
    blocks.push(...data.results);
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

/** Extracts plain text from a single block. Returns empty string for unsupported types. */
function extractBlockText(block: NotionBlock): string {
  const type = block.type;

  if (RICH_TEXT_BLOCK_TYPES.has(type)) {
    const blockData = block[type] as Record<string, unknown> | undefined;
    if (!blockData) return '';
    const richText = blockData.rich_text as NotionRichText[] | undefined;
    return richText?.map(t => t.plain_text).join('') ?? '';
  }

  // Table rows store cells as arrays of rich_text arrays
  if (type === 'table_row') {
    const blockData = block[type] as { cells?: NotionRichText[][] } | undefined;
    return (
      blockData?.cells?.map(cell => cell.map(t => t.plain_text).join('')).join(' | ') ?? ''
    );
  }

  return '';
}

// ── Property helpers ──────────────────────────────────────────────────────────

function extractTitle(props: Record<string, NotionProperty>): string {
  for (const prop of Object.values(props)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map(t => t.plain_text).join('').trim();
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
