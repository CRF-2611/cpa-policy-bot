import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../index';

const HANSARD_BASE = 'https://hansard-api.parliament.uk';
const MEMBERS_BASE = 'https://members-api.parliament.uk';
const LIB_DEM_PARTY_ID = 17;

interface MemberValue {
  id: number;
  nameFullTitle: string;
}

interface MembersSearchResponse {
  items: { value: MemberValue }[];
  totalResults: number;
}

// Matches SearchReferencesItem from the Hansard API spec
interface HansardContribution {
  ContributionExtId: string;
  ItemId: number;
  DebateSection: string;
  Section: string;
  ContributionText: string;
  ContributionTextFull: string;
  SittingDate: string;
  DebateSectionExtId: string;
  HRSTag: string;
  House: string;
  MemberName: string;
  MemberId: number;
}

interface HansardSearchResponse {
  Results?: HansardContribution[];
  TotalResultCount?: number;
}

// Matches WrittenQuestionMembersServiceSearchResult from the Members API spec
interface WrittenQuestionsResponse {
  items?: { value: WrittenQuestionValue }[];
  totalResults?: number;
}

interface WrittenQuestionValue {
  id: number;
  questionText: string | null;
  answerText: string | null;
  answeringBodyName?: string;
  heading?: string | null;
  dateTabled: string;
}

export async function syncParliamentary(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const members = await fetchLibDemMembers();
  console.log(`Parliamentary sync: found ${members.length} Lib Dem members`);

  // First run: backfill 90 days. Subsequent runs: last 2 days.
  const { count } = await supabase
    .from('policy_content')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'hansard');

  const isFirstRun = (count ?? 0) === 0;
  const startDate = isoDate(Date.now() - (isFirstRun ? 90 : 2) * 86_400_000);
  const endDate = isoDate(Date.now());
  console.log(`Parliamentary sync window: ${startDate} → ${endDate} (${isFirstRun ? 'backfill' : 'incremental'})`);

  await syncDebates(supabase, members, startDate, endDate);
  await syncWrittenQuestions(supabase, members);
}

async function fetchLibDemMembers(): Promise<MemberValue[]> {
  const res = await fetch(
    `${MEMBERS_BASE}/api/Members/Search?PartyId=${LIB_DEM_PARTY_ID}&IsCurrentMember=true&skip=0&take=500`,
  );
  if (!res.ok) {
    console.error('Members API error:', res.status);
    return [];
  }
  const data = (await res.json()) as MembersSearchResponse;
  return data.items.map(i => i.value);
}

async function syncDebates(
  supabase: SupabaseClient,
  members: MemberValue[],
  startDate: string,
  endDate: string,
): Promise<void> {
  let synced = 0;
  let failed = false;

  await supabase.from('sync_log').insert({ source: 'hansard', status: 'in_progress', records_updated: 0 });

  try {
    for (const member of members) {
      // Correct endpoint: /search/contributions/{contributionType}.json
      // with queryParameters.* prefix on all query params
      const url = new URL(`${HANSARD_BASE}/search/contributions/Spoken.json`);
      url.searchParams.set('queryParameters.memberId', String(member.id));
      url.searchParams.set('queryParameters.startDate', startDate);
      url.searchParams.set('queryParameters.endDate', endDate);
      url.searchParams.set('queryParameters.take', '500');
      url.searchParams.set('queryParameters.skip', '0');

      const res = await fetch(url.toString());
      if (!res.ok) {
        console.error(`Hansard API error for member ${member.id}: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as HansardSearchResponse;
      if (!data.Results?.length) continue;

      for (const item of data.Results) {
        const debateDate = item.SittingDate?.split('T')[0] ?? startDate;
        const hansardUrl = item.DebateSectionExtId
          ? `https://hansard.parliament.uk/debates/${item.DebateSectionExtId}`
          : null;

        const sourceId = item.ContributionExtId ?? String(item.ItemId);
        const title = item.DebateSection || item.Section || '';
        const content = `${member.nameFullTitle}: ${item.ContributionTextFull || item.ContributionText || ''}`;

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: 'hansard',
            source_id: sourceId,
            title,
            content,
            url: hansardUrl,
            last_updated: debateDate,
            synced_at: new Date().toISOString(),
            metadata: {
              member_name: member.nameFullTitle,
              member_id: member.id,
              house: item.House ?? '',
              hrs_tag: item.HRSTag ?? '',
            },
          },
          { onConflict: 'source,source_id' },
        );

        if (error) console.error('Debates upsert error:', error.message);
        else synced++;
      }
    }
  } catch (err) {
    console.error('Debates sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: 'hansard',
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`Debates sync complete: ${synced} contributions upserted`);
}

async function syncWrittenQuestions(supabase: SupabaseClient, members: MemberValue[]): Promise<void> {
  let synced = 0;
  let failed = false;

  await supabase.from('sync_log').insert({
    source: 'written_questions',
    status: 'in_progress',
    records_updated: 0,
  });

  try {
    for (const member of members) {
      // API only supports pagination via `page` — no date filtering available
      // Fetch page 1 (most recent questions) on each run; upsert ignores duplicates
      const res = await fetch(
        `${MEMBERS_BASE}/api/Members/${member.id}/WrittenQuestions?page=1`,
      );
      if (!res.ok) {
        console.error(`Written questions API error for member ${member.id}: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as WrittenQuestionsResponse;
      // Response uses `items` not `results`
      if (!data.items?.length) continue;

      for (const item of data.items) {
        const q = item.value;
        if (!q) continue;

        const combined = [
          q.questionText,
          q.answerText ? `Answer:\n${q.answerText}` : null,
        ].filter(Boolean).join('\n\n');

        const title = q.heading
          ? `WQ: ${q.heading}`
          : `WQ: ${(q.questionText ?? '').slice(0, 120)}`;

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: 'written_questions',
            source_id: String(q.id),
            title,
            content: `${member.nameFullTitle}: ${combined}`,
            url: `https://questions-statements.parliament.uk/written-questions/detail/${q.id}`,
            last_updated: q.dateTabled?.split('T')[0] ?? isoDate(Date.now()),
            synced_at: new Date().toISOString(),
            metadata: {
              member_name: member.nameFullTitle,
              member_id: member.id,
              answering_body: q.answeringBodyName ?? '',
            },
          },
          { onConflict: 'source,source_id' },
        );

        if (error) console.error('Written questions upsert error:', error.message);
        else synced++;
      }
    }
  } catch (err) {
    console.error('Written questions sync exception:', err);
    failed = true;
  }

  await supabase.from('sync_log').insert({
    source: 'written_questions',
    status: failed ? 'error' : 'success',
    records_updated: synced,
  });

  console.log(`Written questions sync complete: ${synced} questions upserted`);
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}
