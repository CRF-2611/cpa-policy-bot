import { createClient } from '@supabase/supabase-js';
import { handleChat } from './chat';
import { syncNotion } from './sync/notion';
import { syncGdrive } from './sync/gdrive';
import { syncParliamentary } from './sync/parliamentary';

export interface Env {
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  APP_PASSWORD: string;
  SYNC_SECRET: string;
  ASSETS: Fetcher;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/auth') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      let body: { password?: string };
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (body.password === env.APP_PASSWORD) return json({ token: env.APP_PASSWORD });
      return json({ error: 'Unauthorized' }, 401);
    }

    if (pathname === '/chat') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      return withCors(await handleChat(request, env));
    }

    if (pathname === '/session-office') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      let body: { session_id?: string; office?: string };
      try { body = await request.json(); } catch { return withCors(json({ error: 'Invalid JSON' }, 400)); }
      if (!body.session_id?.trim() || !body.office?.trim()) {
        return withCors(json({ error: 'session_id and office required' }, 400));
      }
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      await supabase.rpc('upsert_session', {
        p_session_id: body.session_id,
        p_office: body.office,
        p_first_msg: '',
      });
      return withCors(json({ ok: true }));
    }

    if (pathname === '/chat-history') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      const sid = new URL(request.url).searchParams.get('session_id');
      if (!sid?.trim()) return withCors(json({ error: 'session_id required' }, 400));
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('conversations')
        .select('role, content, created_at')
        .eq('session_id', sid)
        .neq('content', '')
        .order('created_at', { ascending: true })
        .limit(40);
      if (error) return withCors(json({ error: error.message }, 500));
      return withCors(json({ messages: data ?? [] }));
    }

    if (pathname === '/analytics') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const [byOffice, dailyVolume, recentSessions, totals] = await Promise.all([
        supabase.rpc('analytics_by_office'),
        supabase.rpc('analytics_daily_volume', { p_days: 30 }),
        supabase
          .from('sessions')
          .select('office, first_message, created_at')
          .neq('first_message', '')
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('sessions')
          .select('session_id', { count: 'exact', head: true }),
      ]);
      return withCors(json({
        by_office: byOffice.data ?? [],
        daily_volume: dailyVolume.data ?? [],
        recent_sessions: recentSessions.data ?? [],
        total_sessions: totals.count ?? 0,
      }));
    }

    if (pathname.startsWith('/sync/')) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.SYNC_SECRET);
      if (authErr) return authErr;
      return triggerSync(pathname, env, ctx);
    }

    if (pathname === '/admin/notion-debug') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page_size: 10, filter: { property: 'object', value: 'page' } }),
      });
      const data = await res.json();
      return json({ notion_status: res.status, token_prefix: env.NOTION_TOKEN?.slice(0, 10), result: data });
    }

    if (pathname === '/admin/sync') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      ctx.waitUntil(Promise.all([syncNotion(env), syncGdrive(env), syncParliamentary(env)]));
      return json({ status: 'started' }, 202);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log(`Scheduled trigger: ${event.cron}`);
    try {
      if (event.cron === '0 * * * *') {
        await syncNotion(env);
      } else if (event.cron === '30 6 * * *') {
        await syncGdrive(env);
      } else if (event.cron === '0 7 * * *') {
        await syncParliamentary(env);
      }
    } catch (err) {
      console.error(`Sync failed for cron ${event.cron}:`, err);
    }
  },
};

function triggerSync(pathname: string, env: Env, ctx: ExecutionContext): Response {
  const syncFns: Record<string, () => Promise<void>> = {
    '/sync/notion': () => syncNotion(env),
    '/sync/gdrive': () => syncGdrive(env),
    '/sync/parliamentary': () => syncParliamentary(env),
  };

  const fn = syncFns[pathname];
  if (!fn) return json({ error: 'Unknown sync route' }, 404);

  ctx.waitUntil(fn());
  return json({ status: 'started' }, 202);
}

function requireBearer(request: Request, secret: string): Response | null {
  const auth = request.headers.get('Authorization');
  if (auth === `Bearer ${secret}`) return null;
  return json({ error: 'Unauthorized' }, 401);
}

function withCors(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: { ...Object.fromEntries(res.headers.entries()), ...CORS },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
