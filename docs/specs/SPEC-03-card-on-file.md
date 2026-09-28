# SPEC-03 — Card on file at signature (Stripe) · v2

*Status: approved for build 2026-09-18 (supersedes the 2026-09-12 spec and its 2026-09-14 amendment; Gate G cleared for development on Charlie's declaration that SPEC-08 and SPEC-09 are complete) · Priority P0 · Phase 1, Stage 2 · Owner: Claude Code end to end; Charlie's only manual items are listed in §7 · Refs: B-05, B-13, O-04, G-4, SPEC-04 §customers, SPEC-05 task 6, ADR 0004, ADR 0017, ADR 0019 · Glossary in §10.*

## 1. Ground truth this spec is written against (repo `cponitz/cleanbill`, `main` at PR #21, 2026-09-18)

| Item | State |
|---|---|
| Card step | `apps/web/src/components/ClaimResult.tsx` → `CardStep` renders title, body and a **Skip for now** button only; the button posts page event `card_skipped` and continues to the done screen. `ClaimFlow.tsx` reaches the step only when `STRIPE_ENABLED` (`process.env.NEXT_PUBLIC_STRIPE_ENABLED === "true"`, `src/lib/api.ts`) is true; today the Vercel value is `false`, so no customer sees it. Copy block `CARD` in `src/lib/copy.ts` (title, body, skip). |
| Data | `customers.stripe_customer_id text`, `customers.card_on_file boolean not null default false` exist on the **account** table (migration `20260913220000_data_model_v2`). `events.kind` has no check constraint; `card_saved` / `card_skipped` are already in the page allowlist `PAGE_EVENTS` and read by the `/ops` funnel. Portal status page reads `card_on_file` (`claim/index.ts` line ~124) and shows the `STATUS.noCard` / `STATUS.card` copy; `STATUS.addCardSoon` is the placeholder to retire. |
| API | `supabase/functions/claim/index.ts` — routes `GET /claim`, `GET /claim/precheck`, `POST /claim` (multipart), `POST /claim/events`, `POST /claim/reply`, `POST /claim/inquiry`. Service client and `BRAND` / `SUPPORT_EMAIL` in `_shared/db.ts`. No Stripe code anywhere (grep-confirmed). |
| Secrets | Stripe **test-mode** account; `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) in the Mac `.env`; Vercel has `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_STRIPE_ENABLED=false`. Function secrets are set with `supabase secrets set … --project-ref letrfpwskjbgnyacesgv`. Live activation of the Stripe account needs the LLC (O-06) — not a Phase 1 dependency. |
| Copy | `copy/service_agreement.md` §5: "You may provide a card at signup; if you do, we charge it on the due date and email a receipt. We never charge before a refund is issued." (Note: §5 says payment is due 14 days after the invoice; SPEC-05 task 5/6 and the `CARD.body` copy say 3 business days' notice. That is a copy-review item for M8, not for this spec — do not change wording here.) |
| Tests | 57 Python (`pytest`), 40 Deno, `eval/web_smoke.py` scenarios A–E (Playwright, phone viewport). Design-system lint forbids hex / font literals outside `src/styles/`. |

## 2. Problem

Fees are collected two to five months after signature (B-13); without a stored payment method, leakage is modelled at 30–40% (B-05). The card step exists as a placeholder; nothing saves a card.

## 3. Behaviour (customer)

1. After the inline result shows the license matches (`ready_to_submit`) and the customer taps Continue, the page shows the card step: the existing title and body, then Stripe's **Payment Element** for a **SetupIntent** (a save-now-charge-later object; no charge), a consent line, a **Save card** button and the existing **Skip for now** button.
2. **Save card** → the card is saved to the customer's Stripe Customer; the page shows the saved-card line ("Card ending in 4242 saved.") and continues to the done screen. Event `card_saved` is written **by the server** (not the page).
3. **Skip for now** → unchanged: event `card_skipped` (page), continue to done. The agent's `ready_to_submit` follow-up already asks for the "go"; asking for the card again is the portal's job (item 5), not a new e-mail.
4. If the bank asks for authentication (3-D Secure), Stripe's `handleNextAction` runs in place; on failure the element shows Stripe's message and the customer can retry or skip.
5. The portal status page (`/claim/[code]/status`) shows **Add a card** when `card_on_file` is false, opening the same card step for that claim (the customer already has the code as credential, ADR 0017). This replaces the `STATUS.addCardSoon` placeholder and is how a skipped customer adds a card later without a new e-mail.
6. Nothing in this spec charges. Charging is SPEC-05 task 6 and is guarded there (`CHARGE_ENABLED`, notice, dispute window).

**Copy (new strings; compliance-reviewed wording that M8 may still edit — put them in `src/lib/copy.ts` `CARD` and mirror them in `copy/claim_page.md` under a "Card step" heading so the copy file stays the source):**

| Key | Text |
|---|---|
| `CARD.consent` | "By saving a card you authorize Clean Bill Co. to charge it for our 25% fee only after your refund is issued, with at least 3 business days' notice, as described in the service agreement. You can remove the card any time by e-mailing hello@cleanbillco.com." |
| `CARD.save` | "Save card" |
| `CARD.saving` | "Saving…" |
| `CARD.saved` | (last4: string) ⇒ `Card ending in ${last4} saved. Nothing is charged until your refund arrives.` |
| `CARD.failed` | "We couldn't save that card. Check the details or try another card — or skip for now." |
| `CARD.unavailable` | "Card saving isn't available right now. You can add one later from your status page." |
| `STATUS.addCard` (exists) | keep; `STATUS.addCardSoon` is deleted |

Stripe requires explicit consent to save a card for off-session use; the consent line above plus the Save button is that consent, and the server records it (item §5.2).

## 4. Design

### 4.1 Feature flag and keys — served by the API, not by Vercel (change from the 2026-09-14 amendment)

The app is a browser-only client of the claim API (ADR 0017). The 2026-09-14 amendment put the flag and publishable key in Vercel env, which makes every flip a Charlie step and gives the flag two homes. Instead:

- Function secrets (one home): `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_ENABLED` (`"true"`/absent), set by Claude Code with `supabase secrets set`.
- `GET /claim?c=…` (and the poll `GET /claim?c&claim`) gains `features: { card: boolean, stripe_publishable_key: string | null }`. The page mounts the card step only when `features.card` is true; `NEXT_PUBLIC_STRIPE_ENABLED` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` are removed from `api.ts`, `apps/web/README.md` and `.env.example` (Charlie deletes them from Vercel at leisure; they are harmless if left).
- **Rule (write it in `docs/RUNBOOK.md` §9.1 and CLAUDE.md):** `STRIPE_ENABLED=true` in production is allowed only when (a) the keys are **live** keys, or (b) **no real letters have been mailed** (before the SPEC-11 live batch). Test keys reject real cards, so a real customer must never meet a test-mode card form. Until the LLC activates the Stripe account, the flag is flipped on for a test session and off again the same day.

### 4.2 API — `POST /claim/card` (new route in `supabase/functions/claim/index.ts`)

Server-side confirmation with a **confirmation token** (Stripe's current recommended pattern for server-driven SetupIntents): the browser never creates or confirms a SetupIntent itself, so the server always knows which claim and account a saved card belongs to.

Request `{ c, claim, confirmation_token }` (JSON; `c` = claim code, `claim` = claim id — the same pair `POST /claim/reply` uses).

Steps:
1. Load lead by code, claim by id, check they match (404 otherwise); load the account (`customers`) by `claims.customer_id`. Rate limit: reuse the claim GET limiter pattern, 10 per IP per hour for this route.
2. Stripe Customer: if `customers.stripe_customer_id` is null → `POST https://api.stripe.com/v1/customers` with `email`, `name`, `metadata[customer_id]`, `metadata[claim_code]`; store the id. Otherwise reuse (a second claim by the same e-mail reuses the card — acceptance §8.3).
3. `POST /v1/setup_intents` with `customer`, `confirm=true`, `confirmation_token=<token>`, `usage=off_session`, `automatic_payment_methods[enabled]=true`, `automatic_payment_methods[allow_redirects]=never`, `metadata[claim_id]`, `metadata[claim_code]`, `return_url=<site>/claim/<code>/status`. Pinned `Stripe-Version` header (the version current when the PR is opened; recorded in the ADR). Idempotency-Key `card:<claim_id>:<sha256(token)[:16]>`.
4. Result: `succeeded` → set `customers.card_on_file=true`, `customers.card_last4` (new, §5), `customers.card_brand`, `customers.card_consented_at=now()`; insert event `card_saved` (`detail: {claim_id, source: "api", brand, last4}`); audit row `card_saved` on `customers`; respond `{ok:true, status:"succeeded", last4, brand}`. `requires_action` → respond `{ok:true, status:"requires_action", client_secret}` and the page calls `stripe.handleNextAction`, then re-POSTs `{c, claim, setup_intent: <id>}` for the server to retrieve and finish (same step-4 handling). Any other status / Stripe error → `{ok:false, error:"card_declined" | "stripe_error", message}` with Stripe's customer-facing `message` only; log the Stripe error code, never the request body.
5. Stripe calls go through `fetch` with form encoding in a small `_shared/stripe.ts` (three functions: `createCustomer`, `createAndConfirmSetupIntent`, `retrieveSetupIntent`) — no SDK, no new runtime dependency, consistent with how the functions call the Anthropic API today. Unit-test the encoder and the response mapping with Deno tests against fixture JSON.
6. **Flag off** (`STRIPE_ENABLED` not `"true"`) → 409 `{ok:false, error:"card_disabled"}`; `features.card` is false so the page never calls it, but the guard exists anyway.

### 4.3 Page (`apps/web`)

- Dependencies: `@stripe/stripe-js`, `@stripe/react-stripe-js` (the only new runtime dependencies; `loadStripe` is called lazily inside the card step so the marketing pages load nothing from Stripe — check Lighthouse stays ≥ 90 on `/claim/[code]`).
- `CardStep` mounts `<Elements stripe={loadStripe(features.stripe_publishable_key)} options={{ mode: "setup", currency: "usd", paymentMethodCreation: "manual", appearance }}>` and `<PaymentElement options={{ layout: "accordion", defaultValues: { billingDetails: { email } } }}>` (email pre-filled so Link works but is never required). On **Save card**: `elements.submit()` → `stripe.createConfirmationToken({ elements })` → `POST /claim/card` → handle `requires_action` per §4.2 → show `CARD.saved` → `onDone()`.
- `appearance` is built at mount from the live semantic tokens (`getComputedStyle(document.documentElement).getPropertyValue("--color-primary")` etc.: `colorPrimary`, `colorBackground`, `colorText`, `colorDanger`, `fontFamily`, `borderRadius`, `spacingUnit`) so the element follows both themes (O-13) and the design lint stays green (no literal in the component). Add the Payment Element frame to `/design-system` as a static screenshot-free note ("renders inside Stripe's iframe; themed via `appearance`") — do not embed Stripe on the style guide.
- `data-testid`s for the smoke test: `card-step`, `btn-save-card`, `btn-skip-card` (exists), `card-saved`.
- Portal: `StatusView` **Add a card** opens `CardStep` inline for the claim (route stays `/claim/[code]/status`, no new page); hidden when `card_on_file` is true or `features.card` is false.

### 4.4 What the agent and ops see

- `GET /ops` claims already include `customers(card_on_file)`; add `card_last4`, `card_brand` to the drawer's customer line ("Card on file · Visa ····4242") and a `card_on_file` filter chip is **not** needed (the KPI strip already counts `card_saved` events).
- The agent's `get_claim` tool output gains `card_on_file` so drafts can mention it (system prompt unchanged; the `ready_to_submit` template does not mention the card — wording changes only via M8).

## 5. Data changes

Migration `2026MMDDHHMMSS_card_on_file.sql`:
- `customers` add `card_brand text`, `card_last4 text check (card_last4 ~ '^[0-9]{4}$')`, `card_consented_at timestamptz`, `stripe_payment_method_id text` (the id Stripe returns; needed by SPEC-05 task 6 to charge off-session without a lookup).
- No card number, expiry or CVC is ever stored; the schema has nowhere to put them. `supabase/ci/check_schema.sql` asserts the four columns.
- `docs/ARCHITECTURE.md` §4.1 (`customers` rows) and §5 (claim flow, "card" box now real; endpoint table) updated in the same PR; ADR 0021 "Card on file: server-confirmed SetupIntent with confirmation tokens; flag and publishable key served by the API".

## 6. Task table (dependency order)

Owner: **AI** = Claude Code end to end · **C** = only Charlie · **AI→C** = Claude does, Charlie approves. Effort is Claude Code working time.

| # | Task · branch | Owner | Depends on | Effort | Done when |
|---|---|---|---|---:|---|
| S1 | **Secrets** (no branch): `supabase secrets set STRIPE_SECRET_KEY=… STRIPE_PUBLISHABLE_KEY=… --project-ref letrfpwskjbgnyacesgv` from the Mac `.env` values; `STRIPE_ENABLED` left unset. Never echo values. | AI | Mac `.env` has both keys (it does) | 5 min | `supabase secrets list` shows the two names. |
| S2 | **API** · `spec-03-stripe-api`: `_shared/stripe.ts`, `POST /claim/card`, `features` on the GET responses, migration, `check_schema.sql`, rate limiter, audit + event, Deno tests (encoder, status mapping, flag-off guard, code/claim mismatch → 404: 5–6 tests), `selftest` scenario `card` (flag-independent: asserts `features` shape only — a real SetupIntent needs a browser), ARCHITECTURE §4.1/§5, ADR 0021, CHANGELOG. | AI | S1 | 0.5 day | CI green; `curl GET /claim?c=CB-TEST-0001` shows `features`; PR open, stop for review. |
| S3 | **Page** · `spec-03-stripe-web`: dependencies, `CardStep` with Payment Element + appearance from tokens, `requires_action` path, portal **Add a card**, copy keys (`copy.ts` + `copy/claim_page.md`), `README` route/env rows, remove the two `NEXT_PUBLIC_STRIPE_*` reads; `eval/web_smoke.py` scenario **F** (flag on: fill Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP inside the iframe → `card-saved` → done; then `GET /ops` shows `card_on_file=true` for the synthetic claim; grep test: no 16-digit sequence, no `cvc`, no expiry in the API responses, page HTML, `events.detail`, `audit_log.detail`) and scenario A re-run with the flag off (card step absent). Lighthouse mobile `/claim/[code]` ≥ 90. | AI | S2 merged | 0.5–1 day | Smoke F passes on the Vercel preview with `STRIPE_ENABLED=true` set for the run, then the flag is unset again and A passes; PR open, stop for review. |
| S4 | **Charlie's test**: flip `STRIPE_ENABLED=true` (Claude Code runs the command on Charlie's word — see §7), open `https://cleanbillco.com/claim/CB-TEST-0001`, walk to the card step, save `4242…`, see the customer and payment method in the Stripe dashboard (test mode), then say "off" and Claude Code unsets the flag. Reset the test lead (`eval/reset_test_lead.sql` — extend it to clear `card_on_file`, `card_*`, `stripe_*` on the synthetic account). | C · AI runs the commands | S3 merged, deployed | 15 min | Charlie has seen the saved card in Stripe; flag back off. **SPEC-03 complete.** |
| S5 | **Live keys** (later, needs the LLC and the activated Stripe account, O-06): swap the two secrets to `sk_live_` / `pk_live_`, set `STRIPE_ENABLED=true` permanently, re-run smoke F with a real card of Charlie's, then detach the payment method in the dashboard. | AI · C activates Stripe | LLC; SPEC-05 not required | 30 min | A real card saved on production; smoke green. |

Charlie's manual input, in total: S4 (say "on" / test / say "off") and, later, Stripe account activation (S5). Everything else is AI end to end. Nothing here waits on Resend or Lob; S2/S3 can be built in any order relative to SPEC-10 and SPEC-11.

## 7. Charlie's step-by-step (only what cannot be automated)

1. **Nothing before S3 merges.** The keys are already in the Mac `.env`; Claude Code sets the secrets.
2. **S4, test day (15 min):** tell Claude Code "flip Stripe on". It runs `supabase secrets set STRIPE_ENABLED=true --project-ref letrfpwskjbgnyacesgv`. Open `https://cleanbillco.com/claim/CB-TEST-0001` on your phone, go through to the card step (the synthetic license `eval/ids/id_03.jpg` matches), tap **Save card**, enter `4242 4242 4242 4242`, expiry `12/34`, CVC `123`, ZIP `78721`, tap **Save card**. Then open `https://dashboard.stripe.com/test/customers` — the customer (`richard…@` test e-mail) with one card. Tell Claude Code "flip Stripe off"; it unsets the flag and resets the test lead.
3. **Optional, any time:** delete `NEXT_PUBLIC_STRIPE_ENABLED` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in Vercel → Project `cleanbill` → Settings → Environment Variables. They are unused after S3 and harmless if left.
4. **Later (O-06):** once the LLC exists, activate the Stripe account (Stripe dashboard → "Activate your account": legal name, EIN, bank account, website `https://cleanbillco.com`, product description "property-tax refund recovery service; 25% contingency fee charged after the refund is received"), then paste the live keys into the Mac `.env` and tell Claude Code to run S5.

## 8. Acceptance

1. Stripe test card `4242…` completes the flow on the preview and on production (test day); `customers.card_on_file=true`, `card_last4='4242'`, `stripe_customer_id` and `stripe_payment_method_id` set; the Stripe dashboard shows the customer with one payment method; event `card_saved` has `source: "api"`.
2. Smoke passes with the flag on (scenario F) and off (A–E unchanged; card step absent; `features.card=false`).
3. A second claim by the same e-mail reuses the Stripe Customer (Deno test with a fixture account that already has `stripe_customer_id`; no second `POST /v1/customers`).
4. No PAN, expiry or CVC appears in logs, the database, `events.detail`, `audit_log.detail` or any API response — grep test in scenario F and a Deno test that the `_shared/stripe.ts` logger redacts request bodies.
5. `card_skipped` still works and the funnel strip counts both kinds.
6. Flag off → `POST /claim/card` returns 409; code/claim mismatch → 404; wrong IP rate → 429.
7. Lighthouse mobile `/claim/[code]` ≥ 90 with Stripe loaded lazily.
8. Migration applied by `deploy.yml`; `supabase db diff --linked` empty; CHANGELOG, ARCHITECTURE, ADR 0021, RUNBOOK rule (§4.1) in the PRs; no new acronym without a glossary entry.

## 9. Out of scope

Charging (SPEC-05 task 6; it will use `stripe_payment_method_id` + a PaymentIntent with `off_session=true, confirm=true`), refunds of fees, removing a card from the portal (e-mail hello@ for now), Stripe webhooks (`setup_intent.succeeded` adds nothing while confirmation is synchronous; SPEC-05 will add `payment_intent.*`), Apple Pay / Google Pay domain registration (the Payment Element shows them only after the domain is registered in Stripe — do not register in Phase 1), Stripe Accounts v2 (Stripe's newer customer model; Customers v1 is fine and matches `stripe_customer_id`).

## 10. Glossary

**3-D Secure (3DS)** the bank's extra authentication step on some cards · **ADR** architecture decision record (`docs/adr/`) · **API** application programming interface · **B-nn / O-nn / G-nn** business decision / open decision / gap-register item · **CI** continuous integration · **Claim code** the `CB-XXXX-XXXX` credential printed on a letter · **Confirmation token** a Stripe object the browser creates from the Payment Element that lets the server confirm the SetupIntent · **CVC** the card's security code · **Deno** the runtime for Supabase edge functions · **Edge function** a small server program on Supabase at a public URL · **Idempotency-Key** a header that makes a repeated API call return the first result instead of acting twice · **LLC** limited liability company (O-06) · **M8** the copy-review item from the Sep 14 memo · **Off-session** charging a saved card while the customer is not on the site · **PAN** primary account number — the card number · **Payment Element** Stripe's embedded card form · **PR** pull request · **SetupIntent** Stripe's save-now-charge-later object · **Smoke test** `eval/web_smoke.py`, the Playwright script that drives the site end to end · **Stripe Customer** Stripe's record of a payer, referenced by `customers.stripe_customer_id` · **Test mode / test keys** Stripe's sandbox; `sk_test_` / `pk_test_` keys accept only Stripe's test cards.
