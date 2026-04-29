# CPA Policy Bot

## Project overview
A chatbot for Liberal Democrat CPAs to query party policy. 
Uses Claude claude-sonnet-4-6 with a structured search protocol 
across Notion, Google Drive, and parliamentary APIs.

## Stack
- Cloudflare Workers (backend API)
- Cloudflare Pages (frontend)
- Supabase (data storage and sync cache)
- GitHub (source control and CI/CD)

## Architecture
Policy data is synced from source APIs into Supabase on a schedule.
The chatbot queries Supabase rather than calling external APIs live 
on every request. This reduces latency and API rate limit risk.

## Data sync schedule
- Notion Lines to Take: every 60 minutes
- Google Drive briefings: every 6 hours  
- Parliamentary activity (Hansard, written questions): daily at 6am

## Key files
- worker/src/index.ts — main Cloudflare Worker entry point
- worker/src/chat.ts — chat endpoint and Claude tool loop
- worker/src/tools.ts — tool definitions and Supabase query functions
- worker/src/sync/ — sync workers for each data source
- worker/src/system_prompt.ts — full system prompt
- frontend/index.html — chat interface
- supabase/migrations/ — database schema

## External API references
- hansard_api — see /hansard_api file in repo root
- members_api — see /members_api file in repo root

## Environment variables required
ANTHROPIC_API_KEY
NOTION_TOKEN
GOOGLE_SERVICE_ACCOUNT_JSON
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
APP_PASSWORD

## Important
Never call Notion or Google Drive APIs directly from the chat 
request path. Always query Supabase. Live API calls only happen 
in sync workers.
