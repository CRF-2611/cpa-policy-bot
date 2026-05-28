import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function fetchLibDemMembers(): Promise<MemberValue[]> {
  const all: MemberValue[] = [];
  let skip = 0;
  const take = 20; // Members API max page size is 20

  while (true) {
    const res = await fetch(
      `${MEMBERS_BASE}/api/Members/Search?PartyId=${LIB_DEM_PARTY_ID}&House=1&IsCurrentMember=true&skip=${skip}&take=${take}`,
    );
    if (!res.ok) {
      console.error('Members API error:', res.status, await res.text());
      break;
    }
    const data = (await res.json()) as MembersSearchResponse;
    const page = data.items.map(i => i.value);
    all.push(...page);
    if (all.length >= data.totalResults || page.length < take) break;
    skip += take;
  }

  return all;
}

async function syncDebates(
  members: MemberValue[],
  startDate: string,
  endDate: string,
): Promise<void> {
  let synced = 0;
  let failed = false;

  await supabase.from('sync_log').insert({ source: 'hansard', status: 'in_progress', records_updated: 0 });

  try {
    for (const member of members) {
      const url = new URL(`${HANSARD_BASE}/search/contributions/Spoken.json`);
      url.searchParams.set('queryParameters.memberId', String(member.id));
      url.searchParams.set('queryParameters.startDate', startDate);
      url.searchParams.set('queryParameters.endDate', endDate);
      url.searchParams.set('queryParameters.take', '100');
      url.searchParams.set('queryParameters.skip', '0');

      const res = await fetch(url.toString());
      if (!res.ok) {
        console.error(`Hansard API error for member ${member.id} (${member.nameFullTitle}): ${res.status}`);
        continue;
      }

      const data = (await res.json()) as HansardSearchResponse;
      if (!data.Results?.length) continue;

      console.log(`  ${member.nameFullTitle}: ${data.Results.length} contributions`);

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

async function syncWrittenQuestions(members: MemberValue[]): Promise<void> {
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
        `${MEMBERS_BASE}/api/Members/${member.id}/WrittenQuestions?page=1`,
      );
      if (!res.ok) {
        console.error(`Written questions API error for member ${member.id}: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as WrittenQuestionsResponse;
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

async function main() {
  console.log('Parliamentary sync starting…');

  const members = await fetchLibDemMembers();
  console.log(`Found ${members.length} Lib Dem members`);

  if (members.length === 0) {
    console.error('Aborting: Members API returned 0 members (possibly IP-blocked)');
    process.exit(1);
  }

  const { count } = await supabase
    .from('policy_content')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'hansard');

  const isFirstRun = (count ?? 0) === 0;

  if (isFirstRun) {
    // Backfill year by year to avoid Hansard API timeouts on large date ranges
    const currentYear = new Date().getFullYear();
    for (let year = 2021; year <= currentYear; year++) {
      const startDate = `${year}-01-01`;
      const endDate = year === currentYear ? isoDate(Date.now()) : `${year}-12-31`;
      console.log(`Backfilling ${year}: ${startDate} → ${endDate}`);
      await syncDebates(members, startDate, endDate);
    }
  } else {
    const startDate = isoDate(Date.now() - 2 * 86_400_000);
    const endDate = isoDate(Date.now());
    console.log(`Incremental sync: ${startDate} → ${endDate}`);
    await syncDebates(members, startDate, endDate);
  }

  await syncWrittenQuestions(members);

  console.log('Parliamentary sync complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
