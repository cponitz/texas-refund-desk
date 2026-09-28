# Changelog

All notable changes to Clean Bill (named Texas Refund Desk until SPEC-08, 2026-09-17; earlier entries keep that name). Dates are the commit dates on `main`.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags.

## [Unreleased]

### Added
- **SPEC-03 S2: card on file — the API** (ADR 0021; the page step is S3). `POST /claim/card {c, claim, confirmation_token |
  setup_intent}` on the `claim` function saves a card to the claim's account with a **server-confirmed Stripe SetupIntent**:
  the browser hands over the Payment Element's confirmation token, the server creates the Stripe Customer once per account
  (`customers.stripe_customer_id`, reused by a second claim with the same e-mail) and confirms the intent
  (`usage=off_session`, no redirects, `Idempotency-Key card:<claim>:<sha256(token)[:16]>`, pinned `Stripe-Version`
  `2025-09-30.clover`); `requires_action` (3-D Secure) returns the client secret and a second leg with `setup_intent`
  retrieves the outcome from Stripe; `succeeded` writes `card_on_file`, `card_brand`, `card_last4`, `card_consented_at`,
  `stripe_payment_method_id`, the event `card_saved` (`source:"api"`, now server-only — removed from the page allowlist)
  and audit `card_saved` on `customers`. Errors return only Stripe's payer-facing message (`card_declined` /
  `stripe_error`); the request body is never logged and the logger redacts every value but an id allowlist and masks any
  12+ digit run. Guards: flag off → 409 `card_disabled`; code/claim mismatch → 404; every call writes `card_attempt` and
  more than 10 per IP per hour → 429. Every `GET /claim` response (open, closed/portal, poll) now carries `features
  {card, stripe_publishable_key}` — the flag and the publishable key live only in the function secrets (`STRIPE_ENABLED`,
  `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`; `card` is true only with all three), so the `NEXT_PUBLIC_STRIPE_*` Vercel
  variables can go (S3). `_shared/stripe.ts` is three calls over `fetch` with form encoding, no SDK. **Data model:**
  migration `20260928160000_card_on_file.sql` adds `customers.card_brand`, `card_last4` (`check ~ '^[0-9]{4}$'`),
  `card_consented_at`, `stripe_payment_method_id`; no column can hold a card number, expiry or CVC; `check_schema.sql`
  asserts the four columns and the check. `GET /ops` claims carry `customers(card_brand, card_last4)`; `selftest`
  scenario `card` (also from `/ops` → run selftest) asserts the `features` shape and the route guards without a browser;
  `eval/reset_test_lead.sql` clears the card fields on the synthetic account. Tests: `_shared/stripe_test.ts` (5) and
  `claim/card_test.ts` (8) in CI. **Rule** (RUNBOOK §9.1, CLAUDE.md): `STRIPE_ENABLED=true` in production only with live
  keys or before any real letter has been mailed. Nothing here charges (SPEC-05 task 6).
- **SPEC-11 L1–L3: the letter batch and Lob send** (ADR 0023; closes G-7 once L4–L6 run). **Batch (Mac):**
  `python -m cleanbill.letters.batch --batch <name> --tier 1 --n 1000 --variant-split 50 --seed <n> --dry-run` reads the
  published `leads` ⋈ `properties`, applies guard rails no flag can switch off (never `estimate_unconfirmed` (B-18), a
  lead not `new` with `mailed_at` null, `hs_exempt`, `address_suppressed`, the synthetic account / `CB-TEST-`, an
  incomplete Texas address, or a `prop_id` in `data/out/exclude.csv`), draws a stratified sample by market-value band
  (`100–200k … 750k+`, proportional to the eligible population, largest-remainder rounding, `--cap-per-band`) shuffled
  by `--seed` after a sort by claim code (the same seed = the same leads, whatever the row order), interleaves A/B so
  every band is within one letter of the split, verifies every address with Lob (`us_verifications`; only `deliverable` /
  `deliverable_unnecessary_unit` are mailed, with Lob's components on the envelope; the rest become
  `mail_pieces.status='address_rejected'` and the lead stays `new`), prints a counts-only summary (bands with eligible vs.
  sample share, A/B, median estimate, cities, taxing units, excluded by reason, rejected, `--unit-cost` × mailable) and
  writes `data/out/batches/<batch>/<batch>.csv` + 10 sample PDFs (git-ignored). `--send` renders every letter, posts it
  to `POST /v1/letters` (multipart PDF, `to` = verified components, `from` = `brand.RETURN_ADDRESS`, `top_first_page`,
  `usps_first_class`, `use_type=marketing`, `color=false`, `metadata[claim_code|batch|variant|tier]`, `Idempotency-Key
  <batch>:<code>`, 5 req/s, 429 `Retry-After` + 5xx retries ×3), inserts the `mail_pieces` row only after Lob's 200 and
  then sets `leads.status='mailed'`, `mailed_at`, `letter_variant`; re-running the same `--batch` skips leads already in
  it; an error stops the run and prints the resume command. `--to-override "Name|L1|L2|City|ST|ZIP"` mails every letter
  to that address (the proof) with `to_override=true` and never touches a lead. A live key refuses without
  `LOB_ENABLED=true`, `--send`, `--confirm-footer "Clean Bill Co."` (= `brand.LEGAL_NAME`) and a real
  `brand.RETURN_ADDRESS` (new; the placeholder's zip is `00000`; mirrored into `brand_tokens.py` by `--sync`); a test key
  needs only `--send`. `--window-check` renders one synthetic letter through Lob test mode and downloads the render and
  thumbnails for the address-window check. `cleanbill/letters/lob.py` is the client; `generate.py` pins the recipient
  block at `RECIPIENT_TOP_IN = 2.125 in` (the one constant to move after the check), adds the entity / return-address
  line to the footer, and raises rather than spill to a second page. **Data model:** migration
  `20260918220224_mail_pieces.sql` — table `mail_pieces` (lead, claim code, batch, variant, unique `lob_id`, status check
  `address_rejected | created | rendered | mailed | in_transit | in_local_area | processed_for_delivery | re_routed |
  returned_to_sender | deleted`, `to_override`, `to_address`, `address_verification`, `pdf_sha256`,
  `expected_delivery_date`, `delivered_at`, `events`, `last_event_at`), RLS on; SQL functions `ops_mail_kpis()` and
  `ops_mail_by_batch()`; `events.kind` + `mail_returned`; `system_status` key `lob_webhook`; `check_schema.sql` asserts
  them; `eval/reset_mail_batch.sql` resets a test-mode batch. **Webhooks:** `POST /webhooks/lob` in the `webhooks`
  function — `Lob-Signature` / `Lob-Signature-Timestamp` verified in `_shared/webhook_sig.ts` (hex HMAC-SHA256 of
  `timestamp.body` with `LOB_WEBHOOK_SECRET`, seconds or milliseconds, 5-minute skew, constant-time; 401 otherwise),
  `mail_pieces` looked up by `lob_id = reference_id`, status moved forward only (terminal states always apply),
  `{type, at, detail}` appended (capped at 50, never an address), `delivered_at` on `processed_for_delivery`,
  `returned_to_sender` → lead `suppressed` + `events` `mail_returned`; unknown ids → 200. **`/ops`:** `kpis.mailed` now
  counts `mail_pieces` (proofs and rejected excluded) with the lead count as a sub-line cross-check
  (`funnel.leads_mailed`); new **Delivered** and **Returned** tiles; Health gains a **letters** tile (Lob on/off, last
  batch, last webhook) and a **Mail batch** table (pieces, sent, delivered, returned, address rejected, proof badge);
  the drawer's property line shows "Letter B · mailed Oct 5 · delivered Oct 9" from `claim.letter`. Smoke E asserts the
  three tiles, the table and the letters tile render. **Docs:** `docs/specs/SPEC-11`, ADR 0023, ARCHITECTURE (module 6,
  17, 20 rows, §3.3 outbound-mail row, §4.1 `mail_pieces` + leads columns + events / system_status, §4.3 caption, §5.2
  rewritten as the mailing flow, §5.8 GET /ops, glossary), the state-machine figure (`mailed` now written), RUNBOOK §9.3
  (dry run, window check, proof, send, reset) and §9.5, `docs/reports/2026-09-18-lob-proof.md` (what the build verified
  and the L2 / L5 steps still pending Charlie's key). CI runs `webhooks/lob_test.ts` and type-checks `lob.ts`. Tests:
  Python +14 (73), Deno +5 (61). No wording change to the disclaimer or the taxing-unit lines; nothing is printed or
  charged until Charlie's L4 (Lob account, keys, return address, entity name, exclude file) and L5 (webhook, proof).
- **SPEC-10 E1–E3: outbound e-mail from `/ops` through Resend** (ADR 0022; closes G-5 once E4/E5 wire the account).
  **E1 — one template, two renderers, one parity test:** `python -m cleanbill.brand --sync` also generates
  `supabase/functions/_shared/email_template.ts` (the contents of `cleanbill/email/base.html` plus the footer strings —
  `--sync --check` fails when stale); `_shared/email.ts` is a line-for-line port of `cleanbill.email.render_email`;
  `tests/fixtures/email_snapshot.json` (`python -m cleanbill.email --emit-snapshot [--check]`, nine cases: URLs, every
  HTML-special character, whitespace, empty body, the 120-character preheader cut, explicit preheader / header, non-ASCII)
  is asserted byte-for-byte by `tests/test_brand.py` and `_shared/email_test.ts`. **E2 — send action, webhooks, migration:**
  `POST /ops {action: "send", message_id}` e-mails an approved, unsent outbound message to the claim's account address from
  `Clean Bill <hello@cleanbillco.com>` (`reply_to` the same inbox), wrapped in the template, the packet attached as
  `Form-50-114-<code>.pdf` for `ready_to_submit` / `filed` (refused above 20 MB), with `Idempotency-Key: msg-<id>`, tags
  `intent` / `claim_code`, header `X-Entity-Ref-ID`, 20 s timeout; guards in `logic.ts` (`guardSend`, eight Deno tests:
  flag off → 409 `send_disabled`, draft → `draft_not_approved`, `already_sent`, `not_outbound`, `not_email`, `no_email`,
  `empty_message`, `not_found`); the row is claimed with `update … where sent_at is null` so a double-click sends once; on
  2xx `sent_at`, `provider='resend'`, `provider_message_id`, `delivery_status='sent'` + audit `message_send`, on a provider
  error only audit `message_send_failed`. `GET /ops` gains `features {resend, stripe, lob}` (from the secrets) and per-message
  `provider_message_id` / `delivery_status` / `delivery_detail`. New edge function **`webhooks`** (`verify_jwt=false`):
  `POST /webhooks/resend` verifies the Svix signature (`_shared/webhook_sig.ts`: HMAC-SHA256 over `id.timestamp.body`,
  5-minute skew, constant-time compare; three tests — good, bad, stale), maps `email.sent | delivered | delivery_delayed |
  bounced | complained` to `delivery_status`, appends `{type, at, detail}` to `delivery_detail`, writes `events` kind
  `email_bounced` / `email_complained` with the claim code, upserts `system_status.resend_webhook`; unknown ids → 200; opens
  / clicks never change the status (tracking stays off). `RESEND_BASE_URL` lets a test point the function at a fake.
  **E3 — `/ops`:** **Send** (`data-testid="btn-send"`) next to Copy on approved unsent e-mails when `features.resend`,
  disabled with "no e-mail on the account"; busy state; the row turns "sent · time · id" and shows delivered / delayed /
  bounced / complained with Resend's reason on hover; a bounce badges the claim in the list; Health gains a **Mail** tile
  (on / off, last webhook). With the flag off Send is hidden and the copy-into-your-mail-client line stays. Smoke scenario E
  asserts Send is absent with the flag off and, with `RESEND_ENABLED=true` + `SMOKE_INBOX` in `.env`, points the synthetic
  account at that inbox, sends, and asserts `sent_at` / `provider_message_id` through `GET /ops`. **Data model:** migration
  `20260918212142_messages_delivery.sql` — `messages` + `provider` (check `resend`), `provider_message_id` (unique),
  `delivery_status` (check), `delivery_detail jsonb default '[]'`; `events.kind` + `email_bounced`, `email_complained`;
  `check_schema.sql` asserts them. `config.toml` + `[functions.webhooks]`; CI runs the three new Deno test files and
  type-checks `webhooks`; `deploy.yml` deploys five functions. Docs: ARCHITECTURE §3.1 (rows 10, 17, new 20), §3.3, §4.1,
  §5.8, new §5.9, glossary; RUNBOOK §9.2 / §9.5; `apps/web/README.md`; ADR 0022; `docs/specs/SPEC-10`. Tests: Python +1
  (59), Deno +16 (56). No wording change to any customer copy; no send happens until Charlie's E4 (Resend account, DNS,
  mailbox) and E5 (secrets, webhook registration) — until then nothing changes for the operator.
- **SPEC-08 Part C: the Clean Bill design system** (R5; ADR 0019; `docs/DESIGN-SYSTEM.md`). One brand definition every
  surface reads. **Tokens:** `apps/web/src/styles/tokens.css` (spacing, radii, motion, type scale, and every semantic
  token `--color-*`, `--shadow-*`, `--ring`, `--font-*`); the colour / type primitives live in two theme files with the
  same names, `theme-handoff.css` (the SPEC-07 teal / navy set, DM Sans — the default) and `theme-brief.css` (the brand
  brief's forest / amber palette, Source Serif 4 + Inter Tight, tabular figures). `DEFAULT_THEME` in `layout.tsx` is the
  one-line switch for O-13; `?theme=brief` or the toggle on `/design-system` switches the whole site per browser.
  `globals.css` reads semantic tokens only; the JSX's inline `var(--teal)`-style references and `#fff` literals are
  rewritten to semantics. **Component sheet:** the SPEC-07 classes plus, for SPEC-09, `.table` / `.table-wrap`, `.kpi` /
  `.kpis`, `.badge` (status tones from the one map in `src/lib/status.ts`, `StatusBadge`), `.toolbar`, `.drawer`,
  `.btn-sm` / `.btn-bad`, `.input-sm`, `.banner-ok`, with hover / focus-visible / disabled / error / loading states and
  `prefers-reduced-motion`. **Assets:** `apps/web/public/brand/` — wordmark (glyph outlines from the vendored DM Sans
  Bold), mark (an original receipt-with-check line drawing, one geometry in `trd/brand.py`), favicon `.svg` / `.ico`,
  apple-touch icon, Open Graph image, e-mail header; the nav logo is the mark; `layout.tsx` metadata points at them.
  **Adapters:** `python -m trd.brand --sync` generates `trd/brand_tokens.py`, `supabase/functions/_shared/brand.ts` and
  `apps/web/src/styles/brand.generated.ts` from the tokens (CI fails when stale); DM Sans vendored under `trd/fonts/`
  (OFL); the letter (`trd/letters/generate.py` — letterhead wordmark, DM Sans, theme colours; the §41.0051 block
  untouched), the packet data sheet, and both Form 50-114 audit pages (Python and pdf-lib) read them.
  `trd/email/base.html` + `trd.email.render_email()` — table-based, inline-styled template (wordmark header, §41.0051
  footer, support address) with a generated text alternative, for Task 4's Resend send. **Style guide:** `/design-system`
  (noindex, no nav link) renders every token from the live CSS, the type ramp, spacing, every component in every state,
  the status map, the assets on light and dark, the e-mail template in an iframe, and the theme toggle. **Lint:**
  `npm run lint:design` (`apps/web/scripts/design-lint.mjs`) fails on a hex literal, `rgb(` or a literal font family
  outside `src/styles/`, on a primitive read by a component, and on a semantic token that does not resolve in every
  theme; new CI job `design-system` (lint, `tsc`, eslint) and `python -m trd.brand --sync --check` + the contrast table
  in the Python job. Tests: Python +8 (`tests/test_brand.py`: generated files current, both themes resolve and pass the
  WCAG table, fonts vendored with licence, e-mail render, letter carries the wordmark in DM Sans with the disclaimer's
  font unchanged). No wording change; no data-model change; no new runtime dependency (fontTools is a dev-only tool
  for the wordmark SVG).

- **SPEC-09 D3: the old ops page retired.** `docs/ops.html` is a one-line pointer to `https://cleanbillco.com/ops`
  (until SPEC-08 R2 attaches the domain: the project's Vercel production URL + `/ops`). RUNBOOK §9.1 (ops console row),
  §9.2 rewritten as the eight-step daily loop entirely from `/ops` — no SQL step, no Mac step (mark filed, reprocess,
  withdraw, inquiries, walkthrough claims, health all in the console) —, §9.5 (reprocess from the drawer, the login /
  429 case, a red Health tile). ARCHITECTURE §3.2 public URLs, `docs/README.md`. SPEC-09 D1–D3 complete; D4 is Charlie's
  phone review, D5 (Supabase Auth) is Phase 2.
- **SPEC-09 D2: the operator console `/ops`** (`apps/web`; ADR 0020). One page, five anchored sections on the design
  system: **Funnel** (12 KPI tiles incl. filed / approved / refunded / open inquiries, the views → claimed → ready →
  filed strip, events by kind for 7 days and all time, the last 7 days by day), **Claims** (status filter, search,
  dense table with findings counts and a draft marker; a drawer per claim with property / customer / estimate, the ID
  summary — never the DL number —, findings by severity with the code, the 10-minute packet link, drafts with Approve /
  Discard / Copy text, sent or approved messages with Copy, and Mark filed (channel) / Reprocess / Withdraw enabled by
  the same guards as the API), **Inquiries** (every row, unhandled first, Mark handled with a note), **New claim**
  (address or account → preview matches with exemption flags and the lead's estimate → Create → code + link + copy),
  **Health** (deploy / agent run / ETL rows with age and details, Run selftest per scenario with pass / fail and
  seconds). Login card; the ops password lives in `sessionStorage` for the tab and travels as `x-ops-key`
  (`src/lib/ops.ts`); wrong password → error, 429 → its own message, three consecutive 403s → login again. `robots`
  noindex, no link from the site. `eval/web_smoke.py` gains scenario E (wrong then right password → KPIs → approve the
  synthetic claim's draft → mark an inquiry handled → preview `3675 Duval St` → health renders → grep test for the DL
  number / card data on the page and in the API response → three bad keys show the login again; skipped without
  `OPS_PASSWORD` in `.env`). `apps/web/README.md`, ARCHITECTURE §3.1 row 7.
- **SPEC-09 D1: the ops API** (branch `ops-api` work on the session branch; ADR 0020). `supabase/functions/ops` is now
  the operator console's whole backend. `GET /ops?status=&limit=` returns `kpis` (+ `filed`, `approved`, `refunded`,
  `inquiries_open`), `funnel` (`by_kind_7d`, `by_kind_all`, `by_day_30d` aggregated by the new SQL functions
  `ops_events_by_kind` / `ops_events_by_day`, plus the views → claimed → ready → filed strip), `claims` (filter by
  status, limit ≤ 500; extraction without the DL number; packet links signed in one batch; filing `submitted_at` /
  `channel`), `inquiries` (unhandled first) and `system`. `POST /ops` gains `mark_filed {claim_id, channel}` (SPEC-05
  task 1: only from `ready_to_submit`; `filings.submitted_at` + `channel`, claim and lead → `filed`, the followups.md
  "filed" draft, audit row), `reprocess` (re-kicks `process-claim` from `submitted` / `processing`), `withdraw` (any
  open status), `inquiry_handled`, `new_claim {prop_id | address, create}` (walkthrough claims over the published
  properties, preview then confirm → `CB-` code + `https://cleanbillco.com/claim/<code>`), `run_selftest {scenario}`
  (server-side, IPs masked) and `system_status {key, value}`. Failed ops passwords are counted per IP as `events` of
  kind `ops_auth_fail` (20/hour → 429). Guards live in `ops/logic.ts` (mirror of `trd/agent/store.py`, both extended so
  `withdrawn` is reachable from `submitted` and `processing`) with 7 Deno tests (40 total). **Data model:** migration
  `20260917210000_system_status.sql` — new table `system_status (key, value jsonb, updated_at)` (RLS on) and the two
  funnel SQL functions; `deploy.yml`, `agent.yml`, `etl.yml` post their last run (`deploy`: commit + step outcomes;
  `agent_run`: outcome, claims processed, cost; `etl`: outcome, leads) through `POST /ops` with the ops password.
  `supabase/ci/check_schema.sql` checks the table and the function. ARCHITECTURE §3.1 row 10, §4.1, §5.8.

### Changed
- **SPEC-08 Part B3: the Python package is `cleanbill`** (R4; `git mv trd cleanbill`). Every `from trd` / `import trd` /
  `python -m trd.…` in the package, tests, workflows (`ci.yml`, `agent.yml`, `etl.yml`), `pyproject.toml` (`cleanbill*`),
  RUNBOOK, README, CLAUDE.md, ARCHITECTURE, DESIGN-SYSTEM, the figures and the edge-function comments now says
  `cleanbill`. The generated files (`_shared/findings.ts`, `tests/fixtures/findings_snapshot.json`, `_shared/brand.ts`,
  `brand.generated.ts`, `cleanbill/brand_tokens.py`) were regenerated: the snapshot is byte-identical and the only
  change in the others is the header line naming the generator command. CI's scratch database keeps its name. **SPEC-08
  complete** (Parts A, B1–B3, C).
- **SPEC-08 Part B2: repo-internal names** (R3, after Charlie's R2 renames on 2026-09-17: GitHub `cponitz/cleanbill`,
  Vercel project `cleanbill`, Supabase display name `cleanbill`, Mac folder `~/Desktop/ClaudeCowork/cleanbill`,
  cleanbillco.com attached with `texasrefunddesk.com` redirecting). `supabase/config.toml` `project_id`, `pyproject.toml`
  name, `apps/web/README.md` and `eval/web_smoke.py` Vercel names and preview pattern
  (`https://cleanbill-<hash>-ponitz-development.vercel.app`), RUNBOOK §9.1 (production `https://cleanbillco.com`, Actions
  `github.com/cponitz/cleanbill/actions`, Pages fallback `cponitz.github.io/cleanbill/…`, `gh … -R cponitz/cleanbill`),
  CLAUDE.md naming rule, README, ARCHITECTURE §3.2, the architecture figure, `samples/README.md`, `docs/ops.html`. The
  Python package stays `trd` until Part B3.
- **SPEC-08 Part A: rebrand to Clean Bill** (R1; B-19; `docs/specs/SPEC-08-rebrand-clean-bill.md`, `SPEC-09-admin-dashboard.md`,
  `docs/brand/brand-brief.md` and `docs/plans/phase1-v3.2.md` copied in). "Texas Refund Desk" → "Clean Bill" (legal Parties
  line: "Clean Bill Co."), `hello@texasrefunddesk.com` → `hello@cleanbillco.com`, `texasrefunddesk.com` → `cleanbillco.com`
  in the compliance copy (name / e-mail / domain substitution only), the letters (`trd/letters/generate.py`), the packet data
  sheet and the Form 50-114 audit page (Python and TS), the agent system prompt, the edge-function `BRAND` / `SUPPORT_EMAIL`
  defaults, the frozen `docs/` pages and `config.js`, `apps/web` (`notFoundHelp`, README; `metadataBase` / canonical
  `https://cleanbillco.com`), README, CLAUDE.md naming rule, ARCHITECTURE, RUNBOOK (also the stale test counts → 49 / 33),
  `.env.example`, `pyproject.toml` description, `samples/README.md` (`samples/system-map.html` removed — the Cowork project
  keeps the system map). **Claim codes are `CB-XXXX-XXXX`:** generator (`trd/etl/leads.py`), `CODE_RE` and the normaliser in
  `claim/index.ts`, `CODE_PREFIX` / `normalizeCode` / `maskCode` in `apps/web/src/lib/api.ts` (prefix-length aware), the
  selftest and smoke-test code `CB-TEST-0001`, fixtures, eval scripts, figures; the API rejects `TRD-` codes. `SITE_BASE` in
  `trd/ops/new_claim.py` defaults to `https://cleanbillco.com` and links `/claim/<code>`. **Data model:** migration
  `20260917190625_cb_claim_codes.sql` rewrites `leads.claim_code` and `events.claim_code` from `TRD-` to `CB-` (body
  preserved; asserts none remain). ADR 0008 gains a note; no other schema change. Infrastructure slugs
  (`texas-refund-desk`, `trd`) are unchanged until Parts B1–B3.

### Added
- **SPEC-07: the website redesign ("Clean Bill", Ownwell-inspired)** (branch `website-redesign`; ADR 0018; the design
  handoff is copied to `docs/specs/SPEC-07-website-redesign.md`). `apps/web` rebuilt on the handoff's design system: DM Sans
  (self-hosted by `next/font`), the teal/navy token set and the component sheet as CSS in `globals.css`, one `BRAND` /
  `SUPPORT_EMAIL` token (`Clean Bill`, `hello@cleanbillco.com`; repo, Supabase and Vercel names unchanged per B-12; claim
  codes stay `TRD-…`). New pages: `/` (editorial hero, "Start with either" address-or-code card, timeline, fee band, DIY
  callout, "Also from"), `/pricing`, `/how-it-works`, `/faq` (category rail / chips, accordion), `/exemptions`, `/appeals`,
  `/businesses` (portfolio-review form), `/about`, `/claim` (claim-code entry: default → not found → confirm the property;
  "Sign in" and `/app` land here), `/agreement`. `/claim/[code]` restyled as the mobile-first five-step flow (progress
  bar, step eyebrow, choice buttons, upload zone, pinned CTA, navy done screen with the customer's first name; the
  eligibility questions, the §41.0051 sign-step disclosure, the done steps and the agreement keep the compliance-reviewed
  wording). `/claim/[code]/status` is now the portal view: status card with the six-stage progress row and dates,
  documents (Form 50-114, agreement, license purge note), messages with a reply box, estimate, billing, other
  properties. Address / business forms are **lead capture**, not lookup (ADR 0018): they post `POST /claim/inquiry` and we
  answer by e-mail. **Claim API:** `POST /claim/inquiry` (validated by `parseInquiry`, rate-limited 30/IP/h); the closed-lead
  `GET /claim?c` response gains the lead's estimate fields and `claim.{first_name, card_on_file, timeline, messages}`;
  `packet_url` is returned from `ready_to_submit` onward. **Data model:** migration `20260916150000_inquiries.sql` — new
  `inquiries` table (kind, address, email, company, properties, bills, source_path, ip, ua, handled_at, notes); `events.kind`
  gains `inquiry`. Tests: Deno +2 (`parseInquiry`, `stageIndex` / `timelineFrom`; 33 total), Python unchanged (49);
  `eval/web_smoke.py` gains scenario D (every page renders, the FAQ accordion, `/claim` states, the home inquiry form;
  `--skip-inquiry` for a branch run before the deploy). `apps/web/README.md`, `docs/ARCHITECTURE.md` §3.1 / §4.1 / §5.8.
  Not built (needs a decision or a later spec): instant address→estimate lookup, customer accounts / `/app` login, a
  reader for `inquiries` in `ops`, real photography for the `[ photo ]` slots, a `CB-` code prefix.
- **SPEC-04b + SPEC-06b + SPEC-02 UI: the customer web app `apps/web`** (branch `spec-04b-web`; ADR 0017). Next.js 16 App
  Router, TypeScript, Tailwind, deployed by Vercel (Root Directory `apps/web`, preview per branch, production from `main`).
  Routes: `/` landing (code entry, what this is, filing is free at TCAD, the math); `/claim/[code]` — estimate → five
  eligibility questions → typed pre-check (`GET /claim/precheck` on blur) + license photo with camera hint and browser-side
  HEIC→JPEG conversion → contact → review & sign → inline result polling `GET /claim?c&claim` every 2 s (max 30 s) →
  card step (rendered only when `NEXT_PUBLIC_STRIPE_ENABLED=true`; Task 3 fills it) → done; a claimed code opens the
  SPEC-02 fix screen (both addresses side by side, DPS link, what DPS asks for, one upload → re-upload path), the review
  question with a reply box, the SPEC-06 §4 typed-confirmation form (pre-filled), or the ready screen with the 10-minute
  packet link; `/claim/[code]/status`; `/agreement/[code]`. Only `NEXT_PUBLIC_*` env is read; every string is in
  `src/lib/copy.ts` with its `copy/*.md` source named (unreviewed strings marked `NEW`). Funnel events posted:
  `validation_shown, dl_fix_started, dl_fix_uploaded, card_skipped, packet_viewed`. **Claim API additions:**
  `POST /claim/reply {c, claim, body}` stores the customer's answer as an inbound `messages` row (`channel=portal`,
  `intent=reply`); the poll/claim summary gains `typed_prefill` (name, DOB, address — never the DL number) for the typed
  fallback. `eval/web_smoke.py --base <url>`: Playwright, phone viewport, happy path + fix-screen path + agreement, resets
  the synthetic lead itself; passes against the local production build. Lighthouse mobile on `/claim/[code]` (production
  build): performance 99, accessibility 100, best practices 96. `apps/web/README.md`.
  No data-model change. `docs/` static pages untouched (frozen until cut-over).
- **SPEC-06a + SPEC-02 API + G-9: findings rule table, inline-validation API, typed pre-check, license re-upload**
  (branch `spec-02-06-backend`; ADR 0016). One rule table `trd/findings.py` maps each finding code to severity, field, the
  ops sentence, the customer sentence and a next action; `supabase/functions/_shared/findings.ts` is generated from it
  (`python -m trd.findings --emit-ts`) and CI fails when it is stale. Both validators (`_shared/validate.ts`, `trd/agent/validate.py`)
  now emit codes + facts only; the shared fixture gains 16 `validation_cases` and `tests/fixtures/findings_snapshot.json`
  pins both validators' fully rendered output (G-9 closed). Claim API: `GET /claim?c&claim=<id>` poll → `{status, findings[]
  (with customer_message, next_action), packet_url}` (10-minute signed URL when ready); `GET /claim/precheck?c&address&zip`
  (`addressMatches` only, event `typed_precheck`); `POST /claim/events` for the SPEC-06 funnel events; `GET /claim?c` for a
  claimed lead returns the claim summary so the page can render the fix screen. `POST /claim` on a claimed code is now the
  SPEC-02 re-upload (`needs_dl_update` + `dl_front` → new timestamped document, status `processing`, event `dl_fix_uploaded`,
  re-kick) or the SPEC-06 §4 typed confirmation (`needs_review` for `not_readable`/`low_confidence` + `typed_*` fields →
  `typed_id` document, re-kick with `typed_confirmation`); any other status → 409. `process-claim` uses the newest `dl_front`
  (and a back from the same upload), merges typed confirmations over the model's reading, writes `claims.findings` and
  `status_reason` from the table, and quotes the customer sentences in the `needs_review` draft. Selftest gains
  `mismatch_then_fix` (mismatch → re-upload a matching ID → `ready_to_submit` with a second packet → a further re-upload
  gets 409) and every scenario probes the pre-check and the poll. Agent: `FixtureStore` returns documents newest-first like
  `SupabaseStore`; the system prompt lists the codes and what to do with each. **Data model:** migration
  `20260914181236_typed_id_documents.sql` — `documents.kind` allows `typed_id` and `storage_path` is nullable for that kind
  only; `events.kind` gains `typed_precheck, dl_fix_uploaded, validation_shown, dl_fix_started, card_saved, card_skipped,
  packet_viewed`. CI: generated-file check, three Deno test files, edge-function type-check. Tests: 49 Python (+6), 31 Deno (+8).
  Docs: spec amendments 2026-09-14 appended to SPEC-02/03/04/06; runbook refreshed (`gh`, `supabase db diff`, Vercel, `--claim`).
- **SPEC-04 Part A: data model v2** (migration `20260913220000_data_model_v2.sql`). The prototype's `customers`
  table (the engagement) is renamed `claims`; `customer_id` becomes `claim_id` on documents, filings and messages;
  audit rows say `claims`. A new `customers` table is the person/account, matched by e-mail (case-insensitive,
  `citext`), backfilled one per e-mail and linked from `claims.customer_id`; the card fields move to the account.
  `claims.service_type`, `claims.findings` (structured `{code, severity, field, message, detail}`, ADR 0013). SPEC-05's
  schema lands now: `property_values`, `record_checks`, `refunds` v2 columns. The hand-dropped `bulk_load_leads`
  function is declared dropped. The claim API attaches a claim to the account for its e-mail (or creates one);
  `process-claim`, `ops`, `selftest`, the agent store/tools (`claim_id` everywhere, `--claim`, workflow input
  `claim`), the purge job, fixtures and tests follow. Both validators emit structured findings with codes; the ops
  page renders them by severity with the code shown.
- **Migration history matches the hosted project.** Files are named by Supabase's timestamp versions
  (`20260907145033_init_schema.sql` …) and the three migrations that existed only on the server
  (`bulk_load_rpc`, `site_bucket`, `customers_household_prev_homestead`) are in the repo, so `supabase db push` and
  `supabase db diff --linked` work (ADR 0015).
- **CI.** `ci.yml` runs pytest, the Deno validator tests, and applies the whole migration chain in order to a scratch
  Postgres (with `supabase/ci/shim.sql` standing in for the hosted roles and storage schema) followed by a schema
  check. `deploy.yml` runs on merges to `main`: `supabase db push`, `supabase functions deploy`, then
  `supabase db diff --linked` must be empty (fails on drift); optional selftest. Needs repository secrets
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` (and `OPS_PASSWORD` for the selftest).
- **SPEC-01 taxing-unit-aware estimates.** Every property is estimated on its own taxing units from TCAD's
  `PROP_ENT` file instead of the five Austin units. New table `property_entities` (migration
  `0004_property_entities.sql`; one row per property × unit, upserted by `trd/etl/publish.py`). The rate table is
  now data (`trd/estimator/rates/units.json`: 254 TCAD entity codes × tax years 2024–2026 with rate, HS rule, OV65,
  ceiling, per-figure `confirmed` and basis) generated by `trd/estimator/build_units.py` from the county's
  truth-in-taxation rate summary, TCAD's 2026 exemption listing and a cross-check against the certified roll.
  `leads.est_refund_by_year` carries a per-unit breakdown; leads gain `taxing_units`, `unit_names`, `entities`;
  `estimate_unconfirmed` is true when any unit lacks a confirmed rate or exemption for a refund year (or when the
  property's units are unknown). Letters name the property's actual units in the §41.0051(b) block and footer.
  Loader: `--entities`; layout `pacs_8_0_33_prop_ent_slim.json`. Publisher: `--update-estimates` refreshes the
  estimate columns of leads already in Supabase (codes and statuses untouched). Ops CLI stores the units it used.
  Report: `docs/reports/2026-09-13-spec-01-taxing-units.md`. Migration applied to the hosted project 2026-09-13
  (Supabase MCP, recorded as `property_entities`). 13 new tests (41 total).

### Fixed
- `trd.etl.publish` reconnects and retries when Supabase closes the HTTP/2 connection (about 10K requests per
  connection), so `--update-estimates` completes over 16,775 leads; Tier-3 leads are never published unless `--tiers`
  says so (the prototype loaded Tiers 1–2 only; the SPEC-01 CSV contains all tiers).
- Scheduled `claims-agent` runs failed with `ImportError: cannot import name 'create_client' from 'supabase'`:
  the Python client `supabase` was never a declared dependency, so on a fresh runner the repo's own
  `supabase/` folder (migrations, functions) was imported as an empty namespace package. Added `supabase>=2.0`
  to `pyproject.toml`; the workflow installs `.[dev]`. The cron schedule is removed from `agent.yml`
  (manual `workflow_dispatch` only, per ADR 0011) until there is test data. The agent prompt now says to
  move `submitted → processing` before routing, matching the allowed transitions in `trd/agent/store.py`.

### Changed
- Consolidation: the project is named `texas-refund-desk` everywhere. Replaced the last
  `homestead-refund` references (samples/system-map.html links, samples/README.md, the
  `SITE_BASE` default in `trd/ops/new_claim.py`). The public site is
  `https://cponitz.github.io/texas-refund-desk/` (GitHub Pages serves the `docs/` folder at the root).
- Redeployed all four Supabase edge functions (`claim`, `process-claim`, `ops`, `selftest`) from this tree.

### Added
- `CLAUDE.md` (working rules for Claude Code), `docs/ARCHITECTURE.md` (handbook v2.1 sections 3 to 5: modules,
  data model v2, process flows), `docs/RUNBOOK.md` (handbook section 9), `docs/adr/0001..0013` (the T-01..T-13
  technical decisions), `docs/specs/SPEC-01..06` (feature handoffs), `docs/figures/*.svg` (the eight diagrams),
  `docs/README.md`, this changelog.

## [v0.1-prototype] - 2026-09-08

The working end-to-end prototype, built 2026-09-07 to 2026-09-08.

### Added
- **Estimator** (`trd/estimator`): tax rates and exemption amounts for the five Austin taxing units;
  retroactive refund math under Tax Code §11.431; conservative (round-down) display.
- **ETL + lead engine** (`trd/etl`): spec-driven parser for TCAD's PACS 8.0.33 fixed-width export into
  DuckDB; lead heuristic (no homestead flag, mailing address equals situs) with tiering by deed date;
  publisher to Supabase. Real roll loaded: 493,324 accounts, 16,775 Tier-1/2 leads.
- **Letters** (`trd/letters`): outreach letter PDFs (two variants) with the §41.0051 advertisement block
  and a QR code to the claim page.
- **Static site** (`docs/`): index, claim, agreement, and ops pages on GitHub Pages; the Supabase
  functions are pure JSON APIs because `*.supabase.co` responses carry a sandbox CSP.
- **Edge functions** (`supabase/functions`): `claim` (public API keyed by claim code), `process-claim`
  (Claude Haiku ID extraction, validation against the appraisal record, official Form 50-114 fill with
  pdf-lib, e-signature and audit page, follow-up draft), `ops` (password-gated dashboard API),
  `selftest` (synthetic claim through the real path).
- **Claims agent** (`trd/agent`): Claude tool loop with 7 tools over open claims, fixture and Supabase
  stores, allowed status transitions, shadow mode only. GitHub Actions workflow `agent.yml`.
- **ID purge job** (`trd/jobs/purge_ids.py`): deletes license images 30 days after filing, 7 days after
  withdrawal, or 180 days stale; audit-logged.
- **Ops CLI** (`trd/ops/new_claim.py`): creates a claim code for any property in the roll.
- **Eval**: 30 synthetic license photos with labels; extraction eval runner (96.7% field accuracy);
  Playwright browser smoke test; 25-lead verification pack generator.
- **Schema** (`supabase/migrations`): `0001_init.sql` (properties, leads, customers, documents, filings,
  refunds, messages, events, audit_log; RLS on everything; private `ids` and `packets` buckets),
  `0002_app_settings.sql`.
- Tests: 28 pytest cases (estimator, validation mirror, ETL, agent loop with a scripted model, purge
  rules) and 22 Deno cases for the edge-function validator.

### Known gaps at this tag
- The estimator applies Austin ISD and City of Austin rates to every lead; per-property taxing units are
  not yet loaded (SPEC-01).
- Three migrations applied to the hosted database (`bulk_load_rpc`, `site_bucket`,
  `customers_household_prev_homestead`) are not in `supabase/migrations/` (SPEC-04).
- The scheduled `agent.yml` run fails on import of `supabase` (the Python client is not a declared
  dependency, so the repo's `supabase/` folder shadows it as a namespace package).
