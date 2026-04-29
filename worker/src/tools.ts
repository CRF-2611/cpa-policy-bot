import { createClient } from '@supabase/supabase-js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';

export const tools: Anthropic.Tool[] = [
  {
    name: 'search_lines_to_take',
    description:
      'Search Liberal Democrat Lines to Take synced from Notion. Use this first for any policy question — these are the official party positions and key messages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search query' },
        topic: { type: 'string', description: 'Optional topic filter (e.g. "Health", "Housing")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_briefings',
    description:
      'Search policy briefings synced from Google Drive. Use for detailed evidence, statistics, and background on policy areas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_parliamentary_debates',
    description:
      'Search Hansard records of parliamentary contributions by Lib Dem MPs and peers. Use to show how the party has argued its positions in Parliament.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search query' },
        member_name: { type: 'string', description: 'Optional: filter by member name (partial match)' },
        from_date: { type: 'string', description: 'Optional: only include debates on or after this date (YYYY-MM-DD)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_written_questions',
    description:
      'Search written parliamentary questions tabled by Lib Dem members and government answers. Use to find official government responses and parliamentary scrutiny.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search query' },
        answering_body: { type: 'string', description: 'Optional: filter by government department (partial match)' },
      },
      required: ['query'],
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, string>,
  env: Env,
): Promise<unknown> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  switch (name) {
    case 'search_lines_to_take': {
      let q = supabase
        .from('policy_content')
        .select('title, content, url, last_updated, metadata')
        .eq('source', 'notion')
        .textSearch('content', input.query, { type: 'websearch', config: 'english' })
        .limit(5);
      if (input.topic) q = q.eq('metadata->>topic', input.topic);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { results: data ?? [], count: data?.length ?? 0 };
    }

    case 'search_briefings': {
      const { data, error } = await supabase
        .from('policy_content')
        .select('title, content, url, last_updated, metadata')
        .eq('source', 'gdrive')
        .textSearch('content', input.query, { type: 'websearch', config: 'english' })
        .limit(5);
      if (error) return { error: error.message };
      return { results: data ?? [], count: data?.length ?? 0 };
    }

    case 'search_parliamentary_debates': {
      let q = supabase
        .from('policy_content')
        .select('title, content, url, last_updated, metadata')
        .eq('source', 'hansard')
        .textSearch('content', input.query, { type: 'websearch', config: 'english' })
        .order('last_updated', { ascending: false })
        .limit(8);
      if (input.member_name) q = q.ilike('metadata->>member_name', `%${input.member_name}%`);
      if (input.from_date) q = q.gte('last_updated', input.from_date);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { results: data ?? [], count: data?.length ?? 0 };
    }

    case 'search_written_questions': {
      let q = supabase
        .from('policy_content')
        .select('title, content, url, last_updated, metadata')
        .eq('source', 'written_questions')
        .textSearch('content', input.query, { type: 'websearch', config: 'english' })
        .order('last_updated', { ascending: false })
        .limit(5);
      if (input.answering_body) q = q.ilike('metadata->>answering_body', `%${input.answering_body}%`);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { results: data ?? [], count: data?.length ?? 0 };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
