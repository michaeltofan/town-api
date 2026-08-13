/**
 * Fixed identity for the Etapa 4 load-test permanent voting-arena fixture.
 *
 * `civic_ballot_eligible_actors` is append-only by design (see migration
 * 0053 -- `civic_ballot_eligible_actors_append_only` rejects every UPDATE
 * and DELETE, and every FK into it is `ON DELETE RESTRICT`), so once a
 * civic process reaches `voting` its eligible-voter snapshot, its actors,
 * its signal, and its community can never be deleted again. That's the
 * same guarantee a real decided civic process gets in production, and the
 * load test's "vot" scenario needs a real vote to succeed under
 * concurrency to mean anything (a scenario that only ever hits rejection
 * paths can't prove the ballot-token mechanism holds up under real
 * concurrent writes) -- so this fixture is deliberately permanent rather
 * than recreated and torn down every run.
 *
 * It is created once by `loadtest/ensure-voting-arena.ts` (idempotent --
 * a no-op if the community already exists) and never deleted by
 * `loadtest/teardown.ts`. `run-staging-seed.ts`'s row-count preflight
 * guard excludes rows scoped to this community (see its `readCounts`)
 * so this fixture's presence never blocks a future foundation-content
 * reseed.
 */
export const LOADTEST_VOTING_ARENA_COMMUNITY_ID = '00000000-0000-4000-9000-000000000001';
