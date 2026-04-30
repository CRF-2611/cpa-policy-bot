Project overview
A chatbot for Liberal Democrat Commons Parliamentary Advisers (CPAs) to query party policy and draft constituent responses. Built for internal use across 72 MP offices.
The bot follows a strict search protocol defined in the system prompt. It searches policy sources in a fixed priority order and returns bullet point policy lines first, with email drafts only on explicit request.

Stack

Cloudflare Workers — backend API and scheduled sync jobs
Cloudflare Pages — static frontend (single HTML file)
Supabase — policy content cache and conversation history
GitHub — source control, triggers Cloudflare deployment via GitHub Actions
Anthropic API — claude-sonnet-4-6 with tool use


Architecture
Policy data is synced from external sources into Supabase on a schedule. The chatbot queries Supabase rather than calling external APIs live on every request. This keeps response times fast and reduces rate limit risk.
External sources → sync workers → Supabase policy_content table
                                          ↓
User message → Cloudflare Worker → Claude API (tool loop) → Supabase query → response
                                          ↓
                               Supabase conversations table

File structure
/worker
  src/
    index.ts              — Worker entry point, routing, cron triggers
    chat.ts               — POST /chat handler and Claude tool loop
    tools.ts              — Tool definitions and Supabase query functions
    system_prompt.ts      — Full CPA policy instructions as a TypeScript string
    sync/
      notion.ts           — Syncs Notion Lines to Take into Supabase
      gdrive.ts           — Syncs Google Drive briefings into Supabase
      parliamentary.ts    — Syncs Hansard and written questions into Supabase
  wrangler.toml           — Cloudflare Workers config and cron schedule

/frontend
  index.html              — Single file chat interface

/supabase
  migrations/
    001_initial.sql       — Database schema

/hansard_api              — Hansard API reference (parliamentary sync uses this)
/members_api              — Members API reference (parliamentary sync uses this)
CLAUDE.md                 — This file

Supabase tables
policy_content — cached policy data from all sources

id, source, source_id, title, content, url, last_updated, synced_at, metadata (jsonb)
Full text search index on content
Index on (source, last_updated)

sync_log — tracks last sync time per source

id, source, last_sync_at, status, records_updated

conversations — chat session history

id, session_id, role, content, created_at


Sync schedule
SourceFrequencySupabase source valueNotion Lines to TakeEvery 60 minutesnotionGoogle Drive briefingsEvery 6 hoursgdriveHansard contributionsDaily at 6amhansardWritten questionsDaily at 6amwritten_questions

Tools available to Claude
The chat endpoint exposes these tools via the Anthropic tool use API:
searchPolicyContent(query, sources?)
Full text search across policy_content. Optional source filter array. Returns top 10 results with title, content snippet, url, source, last_updated.
getDocumentContent(id)
Fetches full content of a specific policy_content record.
getSyncStatus()
Returns last sync time per source from sync_log.
Claude uses these tools in place of direct Notion/Google Drive/parliamentary API calls. The system prompt maps each search protocol step to a searchPolicyContent call filtered by the appropriate source value.

Parliamentary API references
The parliamentary sync worker reads endpoint definitions from two files in the repo root:

/hansard_api — Hansard spoken contributions API
/members_api — Members API for EDMs

Do not hardcode API URLs in the sync worker. Read them from these files.

Environment variables
Set in Cloudflare dashboard (never in code or committed to GitHub):
VariableDescriptionANTHROPIC_API_KEYAnthropic API keyNOTION_TOKENNotion internal integration token (secret_...)GOOGLE_SERVICE_ACCOUNT_JSONFull Google service account JSON as a stringSUPABASE_URLSupabase project URLSUPABASE_ANON_KEYSupabase anon keySUPABASE_SERVICE_ROLE_KEYSupabase service role key (for sync workers)APP_PASSWORDShared password for frontend accessSYNC_SECRETSecret header value to protect /sync endpoints
Local development: copy these into a .env file (never commit it — it is in .gitignore).

Key implementation notes
Google Drive auth: Use JWT signing with the service account JSON directly against Google REST APIs. Do not use the Google client library — it does not run on Cloudflare Workers edge runtime.
Tool loop: The chat handler must loop until Claude returns a final text response. Claude may call searchPolicyContent multiple times per query (once for Notion, once for parliamentary activity, etc.). Keep looping on tool_use responses until a text response is returned.
Conversation history: Load last 20 messages for the session from Supabase before each API call. Save user message and assistant response after each exchange.
Streaming: The /chat endpoint should stream the response so the frontend can show a typing indicator rather than a blank wait.
Never call external APIs in the chat path: Notion, Google Drive, and parliamentary APIs are only called from sync workers. The chat path queries Supabase only.

Deployment
Push to main branch triggers GitHub Actions → deploys to Cloudflare Workers via wrangler.
After first deployment, trigger initial sync manually:
bashcurl -X POST https://[your-worker-url]/sync/notion -H "X-Sync-Secret: [SYNC_SECRET]"
curl -X POST https://[your-worker-url]/sync/gdrive -H "X-Sync-Secret: [SYNC_SECRET]"
curl -X POST https://[your-worker-url]/sync/parliamentary -H "X-Sync-Secret: [SYNC_SECRET]"

System prompt
The full CPA policy instructions live in worker/src/system_prompt.ts. The instructions define a 10-step search protocol, response formats, sensitive topic handling, an MP lookup table, and absolute content prohibitions.
The system prompt references searchPolicyContent as the tool for all policy searches. It does not reference Notion or Google Drive directly.
