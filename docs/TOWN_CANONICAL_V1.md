# TOWN Canonical V1

Cross-cutting specification for the reusable civic surface on current `main`.

Machine-readable twin: [`civic-surface-foundation.v1.json`](./civic-surface-foundation.v1.json).  
Live HTTP shapes: [`openapi.v1.json`](./openapi.v1.json).

---

## 1. Inspection — current `main`

### town-api

| Item        | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Tip         | `4d7b2bd` (security-health-redaction merge)                            |
| Stack       | Fastify 5 + TypeBox + Drizzle + PostgreSQL 18 · Node 24+               |
| Migrations  | 41 (`0000`…`0040`)                                                     |
| OpenAPI     | 87 paths · OpenAPI 3.1 · no Swagger UI                                 |
| Deploy docs | Staging treated as current live target in `DEPLOYMENT_READINESS_V1.md` |

Recent `main` themes: health redaction + production security headers; `APP_ENV` production policy + Resend; docs truth; platform investigation export; restore-drill + backup attestations.

### town-public

| Item           | Value                                                    |
| -------------- | -------------------------------------------------------- |
| Tip            | `5eeb77a` (member-community-participation merge, PR #86) |
| Phase (README) | Production live + staging isolated                       |
| Live           | `towncivic.org` → `api.towncivic.org`                    |
| Staging        | Railway staging host → `api-staging.towncivic.org`       |
| Product mode   | Product-only HOME/feed; Etapa 3 member journey           |

Recent `main` themes: member-local HOME + explore zone + invite trust; security headers / www redirect; staging API isolation; production API cutover; first-member staging proof; Etapa 3 journey.

### Known docs tension — reconciled 2026-08-10

`town-api` `DEPLOYMENT_READINESS_V1.md` previously said production was not
provisioned and staging was the current target; this was stale and has been
corrected to match this canonical contract (production live at
`api.towncivic.org`, staging at `api-staging.towncivic.org`, region mismatch
between the two documented). Treat **runtime + OpenAPI + this canonical
contract** as authority when any narrative doc disagrees.

---

## 2. Inventory — reusable structures

### Signals

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| Table      | `town.signals` (+ `signal_media_uploads`)                           |
| Status     | `publication_status = published` only; hide via `hidden_at`         |
| Public     | `GET /v1/communities/:slug/signals`, `GET /v1/signals/:id`          |
| Member     | `POST .../signals`, `POST .../signals/media`                        |
| Activity   | `GET /v1/account/activity`                                          |
| Stable     | Foundation seeded content + member publish                          |
| Invariants | Community-scoped; hidden → 404; no actor/account IDs in public DTOs |

### Confirmations

|           |                                                                        |
| --------- | ---------------------------------------------------------------------- |
| Table     | `town.signal_confirmations` unique `(signal_id, actor_id)`             |
| Routes    | `GET/PUT /v1/signals/:id/confirmation`                                 |
| Response  | `{ signalId, confirmed, confirmedAt, confirmationCount }`              |
| Stable    | Participant Session PUT/GET                                            |
| Temporary | `X-TOWN-Control-Key` GET for controlled test actor                     |
| Denial    | Public `403 CIVIC_PARTICIPATION_NOT_AUTHORIZED` (reason only in audit) |

### Submissions

|               |                                                           |
| ------------- | --------------------------------------------------------- |
| Table         | `town.signal_submissions`                                 |
| Statuses      | `pending_review` \| `rejected`                            |
| Route         | `POST /v1/communities/:slug/signal-submissions`           |
| Flag          | `SIGNAL_SUBMISSION_ENABLED` default **false** → 404       |
| Distinct from | Immediate member publish `POST .../signals`               |
| Platform      | list / reject / restore under `/v1/platform/submissions*` |

### Discussions

|        |                                                                            |
| ------ | -------------------------------------------------------------------------- |
| Tables | `signal_discussion_sessions`, `..._contributions`, `..._media_uploads`     |
| Model  | One session per signal; intents `observation\|proposal\|next_step`         |
| Routes | `GET .../discussion-session`, `POST .../contributions`, media upload/proxy |
| Auth   | Session + `canParticipate`                                                 |
| Not    | Chat / comments / social threading                                         |

### Audit

| Trail                    | Table                           | Audience                         |
| ------------------------ | ------------------------------- | -------------------------------- |
| Identity / civic denials | `town.identity_security_events` | Internal / investigation pack    |
| Platform ops             | `town.platform_audit_events`    | Platform console (`read_audit`+) |

Member web surface exposes **no** audit API. Platform console reads bounded audit + investigation export.

### RBAC (three planes)

1. **Community owner** — `accounts.is_owner`  
   Same `participant` level without payment; still needs session + actor + community commitment. Owner moderation only. Not platform.

2. **Platform operator** — `town.platform_operators`  
   `viewer < investigator < moderator < account_admin < ops_admin < role_admin`  
   Fail-closed to generic **404**. Separate from owner.

3. **Session / grants / control key**  
   Session = normal APIs. SetupGrant/RecoveryGrant = ceremony only. Bearer rejected on civic/membership/platform. Control key = temporary confirmation GET only.

### Civic access (runtime truth)

`evaluateCivicAccess` → `participant` when:

- active account
- **and** (`is_owner` **or** temporally valid `active|cancelling` entitlement)
- **and** linked civic actor for the community
- **and** valid community commitment

`paid_pending_binding` never participates. Local eligibility is **not** the V1 gate (flag default false).

> Drift note: `membership-foundation.v1.json` historically said “local eligibility is eligible”; runtime and this canonical contract supersede that line.

---

## 3. Canonical V1 product rules (web)

For authenticated members with recorded commitment:

1. **HOME** shows the member community first.
2. Other cities sit in a separate **explore zone** after an explore divider.
3. External signals carry explore-only copy: participation is reserved for the local community.
4. A community-mismatch **403** is never treated as “not a member.”
5. **Become a member** invite is only for accounts without paid / pending-binding / civic membership truth.

Consumer implementation: `town-public` (`shouldOfferMembershipInvite`, `memberHomeCityId`, `createMemberExploreStory`).

---

## 4. Reuse guidance

**Reuse freely (stable)**

- Schema + repos for communities, signals, confirmations, discussions, submissions
- `evaluateCivicAccess` + community commitment + entitlement transitions
- Session transport (cookie / `Session` header / CSRF)
- Platform roles/capabilities + dual audit append pattern
- TypeBox `$id` schemas mirrored in OpenAPI

**Do not treat as product-default**

- Control-key confirmation path
- Signal-submission queue while flag is off
- Google Play billing while flag is off
- Local-eligibility bind as a participation unlock

**Preserve when extending**

- Fail-closed authz (especially platform → 404)
- Community scoping on actor↔signal actions
- No PII / provider IDs in public civic responses
- Opaque public denial codes; bounded private denial reasons
- Domain separation: account ≠ session ≠ membership ≠ actor ≠ owner ≠ platform operator

---

## 5. Related contracts

| Contract                                     | Role                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `civic-surface-foundation.v1.json`           | This surface — signals / confirmations / submissions / discussions / audit / RBAC |
| `membership-foundation.v1.json`              | Entitlement + civic access + confirmation participation policy                    |
| `billing-foundation.v1.json`                 | Stripe Checkout / Portal / webhooks                                               |
| `account-identity-contract.v1.json`          | Identity architecture                                                             |
| `authentication-ceremony-foundation.v1.json` | Ceremony architecture                                                             |
| `openapi.v1.json`                            | Live HTTP authority                                                               |
