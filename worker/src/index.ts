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
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
      }
      const auth = request.headers.get('Authorization');
      if (!auth || auth !== `Bearer ${env.APP_PASSWORD}`) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const response = await handleChat(request, env);
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        response.headers.set(k, v);
      }
      return response;
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok' });
    }

    return json({ error: 'Not found' }, 404);
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
