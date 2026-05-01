import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';

const VALID_SOURCES = ['notion', 'gdrive', 'hansard', 'written_questions'] as const;
type Source = (typeof VALID_SOURCES)[number];

// ── Tool definitions ──────────────────────────────────────────────────────────

export const tools: Anthropic.Tool[] = [
  {
    name: 'search_policy_content',
    description: `Full-text search across synced policy content.

Sources available:
- "notion"             — Lines to Take (official party positions, updated hourly)
- "gdrive"             — CPA briefings (detailed policy documents, updated every 6h)
- "hansard"            — Parliamentary contributions by Lib Dem MPs/peers (updated daily)
- "written_questions"  — Written questions and government answers (updated daily)

Returns up to 10 results with a relevant content snippet. Pass multiple sources to
search them in parallel. If a snippet is insufficient, call get_document_content with
the result's id to retrieve the full text.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Full-text search query. Supports websearch syntax: phrases in "double quotes", + to require a term, - to exclude.',
        },
        sources: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...VALID_SOURCES],
          },
          description:
            'Optional. Restrict search to one or more sources. Omit to search all sources at once.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_document_content',
    description:
      'Fetches the complete text of a specific policy_content record by its id. Use when a snippet from search_policy_content is insufficient and you need the full document.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the policy_content record (returned in search results).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_sync_status',
    description:
      'Returns the most recent sync time, status, and record count for each data source. Use this when the user asks how current the data is, or when search results seem sparse and you want to check whether a sync has failed.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

// ── Client factory — one client per chat request ──────────────────────────────

export function makeSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<unknown> {
  switch (name) {
    case 'search_policy_content':
      return searchPolicyContent(
        supabase,
        input.query as string,
        input.sources as Source[] | undefined,
      );

    case 'get_document_content':
      return getDocumentContent(supabase, input.id as string);

    case 'get_sync_status':
      return getSyncStatus(supabase);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function searchPolicyContent(
  supabase: SupabaseClient,
  query: string,
  sources?: Source[],
): Promise<unknown> {
  if (!query?.trim()) {
    return { error: 'query must not be empty' };
  }

  const filteredSources =
    sources?.filter((s): s is Source => (VALID_SOURCES as readonly string[]).includes(s)) ?? null;

  const { data, error } = await supabase.rpc('search_policy', {
    p_query: query,
    p_sources: filteredSources,
    p_limit: 5,
  });

  if (error) return { error: error.message };

  return { results: data ?? [], count: (data ?? []).length };
}

async function getDocumentContent(supabase: SupabaseClient, id: string): Promise<unknown> {
  if (!id?.trim()) {
    return { error: 'id must not be empty' };
  }

  const { data, error } = await supabase
    .from('policy_content')
    .select('id, source, title, content, url, last_updated, metadata')
    .eq('id', id)
    .single();

  if (error) return { error: error.message };
  if (!data) return { error: 'Document not found' };

  return data;
}

async function getSyncStatus(supabase: SupabaseClient): Promise<unknown> {
  const { data, error } = await supabase
    .from('sync_log')
    .select('source, last_sync_at, status, records_updated')
    .order('last_sync_at', { ascending: false })
    .limit(40);

  if (error) return { error: error.message };

  const seen = new Set<string>();
  const latest = (data ?? []).filter(row => {
    if (seen.has(row.source)) return false;
    seen.add(row.source);
    return true;
  });

  const missing = VALID_SOURCES.filter(s => !seen.has(s)).map(s => ({
    source: s,
    last_sync_at: null,
    status: 'never_synced',
    records_updated: 0,
  }));

  return { sources: [...latest, ...missing] };
}
