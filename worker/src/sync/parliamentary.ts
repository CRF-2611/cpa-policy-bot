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

interface HansardContribution {
  ExternalId: string;
  Section: string;
  Contribution: string;
  ContributionDate: string;
  DebateType: string;
  DebateSectionExtId: string;
}

interface HansardSearchResponse {
  Results?: HansardContribution[];
}

interface WrittenQuestionValue {
  id: number;
  questionText: string;
  answerText: string | null;
  answeringBodyName: string;
  dateTabled: string;
}

interface WrittenQuestionsResponse {
  results?: { value: WrittenQuestionValue }[];
}

export async function syncParliamentary(env: Env): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const members = await fetchLibDemMembers();
  console.log(`Parliamentary sync: found ${members.length} Lib Dem members`);

  await syncDebates(supabase, members);
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

async function syncDebates(supabase: SupabaseClient, members: MemberValue[]): Promise<void> {
  const yesterday = isoDate(Date.now() - 86_400_000);
  let synced = 0;
  let failed = false;

  await supabase.from('sync_log').insert({
    source: 'hansard',
    status: 'in_progress',
    records_updated: 0,
  });

  try {
    for (const member of members) {
      const res = await fetch(
        `${HANSARD_BASE}/search/contributions.json?memberId=${member.id}&startDate=${yesterday}&endDate=${yesterday}`,
      );
      if (!res.ok) continue;

      const data = (await res.json()) as HansardSearchResponse;
      if (!data.Results?.length) continue;

      for (const item of data.Results) {
        const debateDate = item.ContributionDate?.split('T')[0] ?? yesterday;
        const hansardUrl = item.DebateSectionExtId
          ? `https://hansard.parliament.uk/debates/${item.DebateSectionExtId}`
          : null;

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: 'hansard',
            source_id: item.ExternalId,
            title: item.Section ?? '',
            content: item.Contribution ?? '',
            url: hansardUrl,
            last_updated: debateDate,
            synced_at: new Date().toISOString(),
            metadata: {
              member_name: member.nameFullTitle,
              member_id: member.id,
              debate_type: item.DebateType ?? '',
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
  const yesterday = isoDate(Date.now() - 86_400_000);
  let synced = 0;
  let failed = false;

  await supabase.from('sync_log').insert({
    source: 'written_questions',
    status: 'in_progress',
    records_updated: 0,
  });

  try {
    for (const member of members) {
      const res = await fetch(
        `${MEMBERS_BASE}/api/Members/${member.id}/WrittenQuestions?answered=Any&dateFrom=${yesterday}&dateTo=${yesterday}&take=100`,
      );
      if (!res.ok) continue;

      const data = (await res.json()) as WrittenQuestionsResponse;
      if (!data.results?.length) continue;

      for (const item of data.results) {
        const q = item.value;
        const combined = [q.questionText, q.answerText].filter(Boolean).join('\n\nAnswer:\n');

        const { error } = await supabase.from('policy_content').upsert(
          {
            source: 'written_questions',
            source_id: String(q.id),
            title: `WQ: ${q.questionText?.slice(0, 120) ?? ''}`,
            content: combined,
            url: `https://questions-statements.parliament.uk/written-questions/detail/${q.id}`,
            last_updated: q.dateTabled?.split('T')[0] ?? yesterday,
            synced_at: new Date().toISOString(),
            metadata: {
              member_name: member.nameFullTitle,
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
