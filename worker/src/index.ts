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

    if (pathname === '/chat') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.APP_PASSWORD);
      if (authErr) return authErr;
      return withCors(await handleChat(request, env));
    }

    if (pathname.startsWith('/sync/')) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const authErr = requireBearer(request, env.SYNC_SECRET);
      if (authErr) return authErr;
      return triggerSync(pathname, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log(`Scheduled trigger: ${event.cron}`);
    try {
      if (event.cron === '0 * * * *') {
        await syncNotion(env);
      } else if (event.cron === '0 0,6,12,18 * * *') {
        await syncGdrive(env);
      } else if (event.cron === '0 6 * * *') {
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
