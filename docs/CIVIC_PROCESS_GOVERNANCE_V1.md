# TOWN — Civic Process Governance Specification V1

Status: **approved** (owner sign-off recorded 2026-08-06, in the session that
produced this document). This is the Etapa 0 contract requested for the
civic-process build-out: it removes ambiguity before code, and every future
PR against the civic process must conform to it or amend it explicitly.

Authority order, same convention as sibling foundation contracts:

1. Runtime code under `src/` (triggers, routes, schema checks) — the current
   implemented baseline.
2. This document — the contract for what is implemented today plus what is
   specified for the remaining build-out.
3. `docs/civic-surface-foundation.v1.json` and `docs/openapi.v1.json` for the
   broader civic-surface reuse boundaries and live HTTP shapes.

Sections marked **[V1 — implemented]** describe the system as it runs in
production today, verified against `src/routes/civic-process*.ts`, the
`drizzle/0041`–`0050` migrations, and `test/civic-process*.test.ts`. Sections
marked **[V2 — specified, not yet built]** are decisions made now, to be
implemented in the PR sequence at the end of this document — they are
committed rules, not open questions.

## 1. Process states **[V1 — implemented]**

One canonical, append-only process per published signal:

```
confirmation → proposals → deliberation → ballot_preparation → voting
  → mandate → action → verification → archived
```

- Provisioned automatically when a signal is created (`AFTER INSERT` trigger
  on `town.signals`; see `drizzle/0041_civic_process_confirmation.sql`).
- `current_stage` cannot be changed by a direct `UPDATE` — a trigger
  (`civic_processes_no_direct_stage_change`) rejects it. The only way to
  advance a stage is the specific, audited transition path for that stage.
- Every transition writes one row to the append-only
  `civic_process_transitions` ledger (`from_stage`, `to_stage`, `reason_key`,
  `occurred_at`) and one row to `civic_process_events`. Both tables reject
  `UPDATE`/`DELETE` at the trigger level.

## 2. Who can open and advance each stage **[V1 — implemented]**

| Stage              | Opened by                                                                      | Advanced by                                                                      |
| ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| confirmation       | automatic, at signal creation                                                  | any active civic actor in the signal's community confirming; threshold-triggered |
| proposals          | automatic, on confirmation threshold                                           | any eligible actor publishing a proposal; threshold-triggered                    |
| deliberation       | automatic, on proposal threshold                                               | any eligible actor contributing; threshold-triggered                             |
| ballot_preparation | automatic, on deliberation threshold                                           | automatic, same transaction (see §8)                                             |
| voting             | automatic, chained from ballot_preparation                                     | lazy close on read once `voting_closes_at` elapses                               |
| mandate            | automatic, on voting close                                                     | automatic (winner computed at close)                                             |
| action             | automatic, only if mandate has a decided winner (not contested)                | any active community actor posting a status update                               |
| verification       | opened by any eligible actor marking the action `ready` — no threshold to open | closes via the symmetric 5-actor threshold (§13)                                 |
| archived           | automatic, on verification outcome reached                                     | terminal                                                                         |

No stage transition is ever a free-form operator action. Operators (§14) can
moderate content inside a stage; they cannot push the process forward or
backward.

## 3. Transition conditions (thresholds) **[V1 — implemented]**

- Confirmation → proposals: `CIVIC_CONFIRMATION_THRESHOLD = 5` distinct
  actors confirming.
- Proposals → deliberation: `CIVIC_PROPOSAL_THRESHOLD = 5` published
  proposals.
- Deliberation → ballot_preparation: `CIVIC_DELIBERATION_THRESHOLD = 5`
  distinct actors contributing (`count(DISTINCT author_actor_id)`).
- Ballot_preparation → voting: immediate, same transaction (§8).
- Voting → mandate: lazy, on the first read after `voting_closes_at` has
  elapsed (`closeVotingWindowIfElapsed`); no scheduled job.
- Action → verification: any eligible actor marks the action `ready`; no
  threshold.
- Verification → archived: first of `delivered_count >= 5` or
  `not_delivered_count >= 5` (symmetric, §13).

All thresholds are enforced inside the same transaction as the row that
crosses them (a `SELECT ... FOR UPDATE` guard, not a background job), so a
threshold can only be crossed exactly once.

## 4. Deadlines **[V1 — implemented, §8/§9 add to this]**

- `voting_closes_at` is set when voting opens (§8) and enforced lazily on
  read — there is no cron/scheduled closer.
- No other stage has a hard deadline in V1. `closingAt` in the public
  `/civic-process` response is `null` outside `voting`.
- **[V2 — specified]** Ballot preparation (§8) introduces `votingOpensAt` /
  `votingClosesAt` fixed at freeze time; the voting window duration is fixed
  at **72 hours** from freeze, non-configurable in V1 (no per-signal
  operator override — avoids a moderation-influence vector on outcomes).

## 5. Eligibility **[V1 — implemented]**

Defined once, reused everywhere (`evaluateCivicAccess`,
`docs/civic-surface-foundation.v1.json`):

- `participant` access requires: active account **AND** (`accounts.is_owner`
  **OR** a temporally valid membership entitlement, status `active` or
  `cancelling`) **AND** a linked civic actor for the signal's community
  **AND** a recorded, valid community commitment.
- `paid_pending_binding` never grants `participant`.
- Local/GPS eligibility is reported only, not gating, in V1
  (`LOCAL_ELIGIBILITY_ENABLED` defaults false).
- One civic actor per account per community. Confirmations, proposals,
  deliberation contributions, votes, action updates, and verification
  confirmations all key off `actor_id`, never `account_id` directly.

## 6. Proposal rules

**[V1 — implemented]** A proposal has `title` (≤160 chars) and `body`
(≤2000 chars), one per eligible actor per process
(`civic_proposals_process_actor_unique`), only while `current_stage =
'proposals'`.

**[V2 — specified]** The proposal object is extended with:

- `targetInstitution` (optional, ≤200 chars) — who the ask is directed at.
- `expectedOutcome` (required, ≤500 chars) — what success looks like.
- `estimatedResources` (optional, ≤500 chars) — free text, not a budget
  system in V1.
- `indicativeDeadline` (optional date) — non-binding target.
- Evidence: reuses the existing signal-media upload path, 0–3 attachments.
- Lifecycle: `draft → published → revised → eligible → frozen → withdrawn`.
  - `draft` is client-side only until first `published` — no draft rows are
    persisted (matches "no invented backend state" precedent elsewhere in
    this codebase).
  - `published → revised`: the author may edit **once** before the stage's
    threshold is reached; each revision keeps the prior version in an
    append-only `civic_proposal_revisions` table (never overwritten).
  - `eligible`: default state for a published/revised proposal once
    deliberation opens — no separate operator action needed unless flagged.
  - `frozen`: set automatically at ballot preparation (§8) — no further
    edits, ever.
  - `withdrawn`: author-only, allowed any time before `frozen`. A withdrawn
    proposal keeps its full history visible; it is excluded from the ballot.
  - Operators can set an eligible/published proposal to a moderation-hidden
    state with a mandatory reason (§14) — this is a separate flag from the
    lifecycle above, not a lifecycle state, so moderation is always visible
    as moderation and never silently rewrites the civic history.

## 7. Deliberation rules

**[V1 — implemented]** Contributions carry `intent ∈ {observation, proposal,
next_step}`, are linked to a specific proposal and process, only while
`current_stage = 'deliberation'`.

**[V2 — specified]** `intent` is extended to:

```
observation | proposal | next_step | argument_for | risk_or_objection
| question | author_response | evidence | amendment_suggestion
| minority_position
```

- `author_response` and `question`/`amendment_suggestion` pairs are linked
  via an optional `replyToContributionId` (self-referencing, nullable) so a
  thread is reconstructable without inventing a full comment-tree UI.
- `minority_position` is a marker intent, not a separate voting mechanism —
  it exists so a dissenting view is preserved verbatim in the permanent
  record even after the majority proposal is selected (feeds the mandate's
  minority-position field, §11).
- A structured deliberation summary (open questions count, revised
  proposals, time remaining) is computed server-side from these typed rows —
  never a free-text field an operator or author edits directly. An
  AI-assisted summary may be added later, but only as a labeled, separately
  versioned annotation on top of the raw contributions, never replacing them
  as the record of truth (per the owner's explicit instruction against
  letting a generated summary become civic truth without accountable
  review).

## 8. Ballot preparation

**[V1 — implemented]** None as a distinct stage — `ballot_preparation` exists
as a named state in the migration but the transition into `voting` happens
in the same transaction, with no separate freeze step or preview.

**[V2 — specified]** Ballot preparation becomes a real gate:

- On entering `ballot_preparation`: every proposal not `withdrawn` is set to
  `frozen` (title/body/evidence locked); the eligible voter list is snapshot
  into a `civic_ballot_eligible_actors` table (append-only, one row per
  actor at freeze time) — later membership changes never add or remove
  eligible voters for a ballot already frozen.
- The exact ballot question is fixed at freeze time: for V1 this is always
  **"Which proposal should this signal's mandate be?"** — no per-signal
  custom question text in V1 (avoids an operator-influence vector on framing).
- `votingOpensAt` is set to freeze time; `votingClosesAt` = freeze time + 72h
  (§4).
- The public `/civic-process` response exposes a **ballot preview** once in
  `ballot_preparation`: frozen proposal list, question, opens/closes
  timestamps, quorum and win rule (§9) — all visible before voting opens, so
  no rule is ever revealed only after the fact.
- This stage still has **no manual operator trigger** — it opens
  automatically at the deliberation threshold and closes automatically after
  a fixed **10-minute** freeze window (long enough for the snapshot writes
  and preview to be readable, short enough that it is not a stage anyone
  needs to "do" anything in).

## 9. Ballot type, quorum, win rule

**[V1 — implemented]** One vote per eligible actor per process
(`civic_votes_process_actor_unique`), votes cannot be changed once cast,
`voting_closes_at` enforced lazily. **Not a secret ballot** — the vote is
linked to the actor internally for eligibility and one-person-one-vote
enforcement, and this is disclosed, not presented as anonymous
(`src/routes/civic-voting.ts`).

**[V2 — specified]**

- **Ballot type**: approval voting among the frozen, non-withdrawn proposals
  plus a standing **"No proposal — continue deliberation"** option, exactly
  as the owner specified. Binary Da/Nu/Abținere is reserved for a future
  single-proposal ballot type and is not built in this iteration.
- **Quorum**: at least 5 of the frozen eligible-voter snapshot must vote, or
  the process reports `contested: true, reason: 'quorum_not_reached'` and
  returns to `deliberation` (proposals stay `frozen`; a new
  `ballot_preparation` cycle is required to re-open voting — this is a new,
  explicitly audited transition, not a silent retry).
- **Win rule**: the proposal with strictly the most approvals wins. A tie at
  the top, or "No proposal" winning outright, both resolve to
  `contested: true` with **no invented tie-break** — this preserves the
  existing precedent in `civic-mandate.ts` (`mandate.proposalId === null`)
  and extends it to the "No proposal" case.
- **Secret ballot** (the owner's flagged infrastructure-sensitive item):
  adopted approach for V1 — a **separate anonymized ballot table**, decoupled
  from actor identity at cast time:
  - At ballot open, one single-use, opaque cast token per eligible actor is
    minted and stored linked to `actor_id` in a `civic_ballot_tokens` table
    (separate from any vote content).
    - Casting a vote consumes the token (marks it used, one-way) and writes
      the choice into `civic_votes` **without a foreign key back to
      actor_id or account_id** — only `process_id`, `proposal_id` (or the
      "no proposal" sentinel), and `cast_at`.
    - Eligibility and one-vote-per-actor are enforced via the token
      consumption, not via a link from the vote row to the actor.
    - **Threat model, stated plainly**: this protects against casual
      identity-choice correlation in the product surface and against any
      single query joining `civic_votes` to an actor. It does **not**
      protect against an operator with direct, unaudited production
      database access correlating token-issuance order with vote-insertion
      order/timing if they control both tables' write path — a fully
      coercion-resistant, publicly verifiable secret ballot (mix-nets,
      blind signatures, zero-knowledge tallying) is out of scope for V1 and
      is not claimed. The product copy must say "your identity is not
      stored with your vote" and must **not** say "cryptographically
      verifiable" or "anonymous by design" until a stronger scheme replaces
      this one.
  - This is a deliberate, disclosed trade-off, not a placeholder pretending
    to be more than it is — matching the owner's own stated principle that
    TOWN must not claim secrecy it cannot back.

## 10. Cancellation and contestation

**[V1 — implemented]** A tied/no-winner mandate is reported `contested`,
never resolved by an invented rule (§9 extends this to quorum failure and
"No proposal" wins).

**[V2 — specified]**

- Any eligible actor may file a **procedural contestation** against a closed
  vote within **72 hours** of `voting_closes_at`, citing one of a fixed
  reason set: `eligibility_error`, `ballot_tampering_suspected`,
  `count_discrepancy`. Free-text elaboration is stored but the reason code
  drives routing.
- A filed contestation moves the process to a `verification_pending`
  **sub-flag** on the mandate stage (not a new top-level stage — the
  canonical 9-state sequence in §1 does not change) and requires an operator
  with the new `moderate_civic_process` capability (§14) to record a
  procedural review outcome: `upheld` (recount from the untouched
  `civic_votes` table, published) or `rejected` (with reason). Both outcomes
  are public and permanent.
- A **civic jury** (a small panel of randomly-selected eligible actors from
  the same community, outside the disputing parties) is the V2 design intent
  for contestations an operator cannot resolve procedurally (i.e. a dispute
  about the outcome's legitimacy, not just a counting error) — deferred past
  this PR sequence; V1 handles only procedural review by an operator.

## 11. Civic mandate **[V1 — implemented, §9/§10 extend it]**

A decided mandate is a permanent record: question, voted proposals, rule
applied, eligible-voter count, participation, aggregated results, winning
proposal, adoption date. **[V2]** adds: minority position (from §7), any
contestation outcome (§10), and is still never edited retroactively —
corrections are published as a linked amendment record, never an in-place
edit, exactly as specified.

## 12. Civic action **[V1 — implemented]**

Status updates only in V1 (`not_started → in_progress → blocked →
completed`, free-text updates, community-scoped, no threshold to open).

**[V2 — specified]** Adds: named responsible actor + optional collaborators,
target institution, objective, indicative deadline, structured
blocked-reason on the `blocked` state, and the contextual actions from the
owner's spec (`Îmi asum un pas`, `Ofer ajutor`, `Publică o actualizare`,
`Adaugă o dovadă`, `Înregistrează răspunsul instituției`) as typed update
subtypes, not new tables — they reuse `civic_action_updates` with a `kind`
column.

## 13. Result verification **[V1 — implemented]**

Symmetric 5-actor threshold for `delivered`/`not_delivered`, evidence
attachable, disputed state (`neither reaches 5`) reported honestly with no
invented resolution (`src/routes/civic-verification.ts`).

**[V2 — specified]** A dispute that stays unresolved for **14 days** after
verification opened routes to the same procedural-review path as §10
(operator with `moderate_civic_process`, public permanent outcome), rather
than staying open indefinitely with no path to archive.

## 14. Operator rights **[V1 — implemented, extended]**

Existing capability ladder (`src/platform/roles.ts`):
`viewer < investigator < moderator < account_admin < ops_admin < role_admin`.
Operators moderate; they never advance or reverse a civic-process stage.

**[V2 — specified]** New capability `moderate_civic_process`, minimum role
`moderator` (same rank as `moderate_signals`), covering exactly:

- Hiding a proposal/contribution/evidence item with a mandatory reason
  (mirrors existing `signal-moderation` pattern — hidden, not deleted).
- Recording a procedural contestation outcome (§10) or a stalled
  verification-dispute outcome (§13).
- Restoring a moderation-hidden item.

None of these capabilities can set `current_stage`, touch
`civic_process_transitions`/`civic_process_events` directly, or alter a
published mandate. Every use is written to `town.platform_audit_log` exactly
like existing operator actions.

## 15. Audit events **[V1 — implemented, extended]**

Already permanent and queryable: every `civic_process_transitions` row,
every `civic_process_events` row, every operator action via
`platform_audit_log`. **[V2]** adds to the audited event set: proposal
revisions (§6), ballot freeze snapshots (§8), contestation filings and
outcomes (§10), and `moderate_civic_process` actions (§14) — all via the
same existing audit mechanisms, no new logging system.

## Build sequence

Matches the owner's PR plan, one slice per PR, API before its dependent UI:

| #   | Repo                                | Delivers                                                       |
| --- | ----------------------------------- | -------------------------------------------------------------- |
| 1   | town-api (this doc)                 | This governance specification                                  |
| 2   | town-api                            | _(done — confirmation-stage nucleus, PR #94 and earlier)_      |
| 3   | town-public                         | _(done — confirmation-stage right panel, PR #99–#101)_         |
| 4   | town-api                            | Rich proposal object + lifecycle (§6)                          |
| 5   | town-public                         | Proposal authoring/list UI for the new fields                  |
| 6   | town-api                            | Extended deliberation intents + reply threading (§7)           |
| 7   | town-public                         | Deliberation UI for the new intents                            |
| 8   | town-api                            | Real ballot-preparation gate + freeze snapshot (§8)            |
| 9   | town-api + town-public, coordinated | Secret-ballot vote table + approval ballot (§9)                |
| 10  | town-api + town-public              | Mandate extensions: minority position, contestation (§10, §11) |
| 11  | town-api + town-public              | Action extensions (§12)                                        |
| 12  | town-api + town-public              | Verification dispute routing (§13)                             |
| 13  | town-api + platform console         | `moderate_civic_process` + contestation review UI (§14)        |
| 14  | town-public                         | HOME civic center surfacing real process state                 |
| 15  | town-api + town-public              | Notifications / Civic Inbox / civic profile extensions         |
| 16  | town-public                         | Mobile parity pass                                             |

Each PR must update this document in the same PR if it changes a decision
recorded here — this file is the contract, not the README.
