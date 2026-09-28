# ADR 0021: card on file — server-confirmed SetupIntent with confirmation tokens; flag and publishable key served by the API

- **Date:** 2026-09-28
- **Status:** Accepted
- **Handbook ID:** SPEC-03 v2 (B-05 leakage, B-13 charge only after an observed refund, O-04, G-4; SPEC-04 `customers`; SPEC-05 task 6; ADR 0004, ADR 0017, ADR 0019)

## Decision

1. **The browser never creates or confirms a SetupIntent.** The card step mounts Stripe's Payment Element in `setup` mode
   with `paymentMethodCreation: "manual"`, the page calls `stripe.createConfirmationToken({ elements })` and posts the
   token to `POST /claim/card {c, claim, confirmation_token}`. The claim function creates the SetupIntent with
   `confirm=true`, `confirmation_token=<token>`, `usage=off_session`, `automatic_payment_methods[allow_redirects]=never`
   and the claim's id and code in `metadata`. So every saved card is tied, server-side, to a known claim and account; the
   page cannot attach a card to someone else's account, and there is no client secret to leak before the server has
   decided. When the bank asks for 3-D Secure, the server answers `requires_action` with the client secret, the page runs
   `stripe.handleNextAction`, and re-posts `{c, claim, setup_intent}`; the server **retrieves** the intent from Stripe and
   records what Stripe says — it never trusts the page's report of the outcome.
2. **Idempotent by construction.** `Idempotency-Key: card:<claim_id>:<sha256(token)[:16]>` — a retried POST with the same
   token confirms once and returns the first result. A second claim by the same e-mail reuses `customers.stripe_customer_id`
   (no second `POST /v1/customers`), so a household with two properties has one Stripe Customer.
3. **Three calls over `fetch`, no SDK.** `_shared/stripe.ts` form-encodes the request (`a[b]=c`, `a[0]=x`), pins
   `Stripe-Version: 2025-09-30.clover` and exposes `createCustomer`, `createAndConfirmSetupIntent`,
   `retrieveSetupIntent`. Same shape as the Anthropic, Resend and Lob calls; no new runtime dependency in the functions;
   the encoder and the response mapping are unit-tested against fixture JSON. The version is bumped deliberately (a new
   ADR line, the tests re-run), never by default.
4. **The server writes what it learns and nothing more.** On `succeeded`: `customers.card_on_file=true`, `card_brand`,
   `card_last4` (a `^[0-9]{4}$` check makes anything longer impossible to store), `card_consented_at=now()` (the consent
   line + Save button is the off-session consent Stripe requires; the timestamp is the record of it) and
   `stripe_payment_method_id` (so SPEC-05 task 6 can charge off-session without a lookup). Event `card_saved` (`source:
   "api"`, brand, last4) and audit `card_saved` on `customers` are written **by the server**; `card_saved` leaves the
   page-event allowlist so it cannot be double-counted or forged. The page still posts `card_skipped`. No card number,
   expiry or CVC ever reaches our code (they stay in Stripe's iframe); the Stripe logger still redacts every request value
   except an allowlist of ids and masks any run of 12+ digits, tested.
5. **The flag and the publishable key have one home: the function secrets.** `STRIPE_ENABLED`, `STRIPE_SECRET_KEY`,
   `STRIPE_PUBLISHABLE_KEY` are set with `supabase secrets set`; `GET /claim?c=…` (both the open response, the closed /
   portal response and the poll) carries `features: {card, stripe_publishable_key}`; the page mounts the card step only
   when `features.card` is true and the `NEXT_PUBLIC_STRIPE_*` Vercel variables go away (S3). `card` is true only when the
   flag is `"true"` **and** both keys are present, so a half-configured project fails closed. `POST /claim/card` answers
   409 `card_disabled` when the flag is off, even though the page never calls it then. **Rule (RUNBOOK §9.1, CLAUDE.md):**
   `STRIPE_ENABLED=true` in production only with live keys, or before any real letter has been mailed — a real customer
   must never meet a test-mode card form, because test keys reject real cards.
6. **Rate limit like the other routes.** Every `POST /claim/card` writes a `card_attempt` event (`detail.ip`, the leg:
   `confirm` / `after_action`); more than 10 per IP per hour → 429. The page sees only Stripe's customer-facing `message`
   (`card_declined` for card errors, `stripe_error` for anything else); the error code goes to the log, the request body
   never does.
7. **Nothing here charges.** No `PaymentIntent`, no webhook (confirmation is synchronous; `setup_intent.succeeded` would add
   nothing), no Apple Pay / Google Pay domain registration, no card removal from the portal (e-mail hello@ for now). The
   charge is SPEC-05 task 6 behind `CHARGE_ENABLED`, notice and the dispute window (B-13).

## Consequences

- Deno tests: `_shared/stripe_test.ts` (encoder, SetupIntent / error mapping, redaction, idempotency key, pinned version)
  and `claim/card_test.ts` (features, body parsing, flag-off 409, mismatch 404, first card, Customer reuse,
  `requires_action` two legs, decline) run in CI; `claim/card.ts` is type-checked. `selftest?scenario=card` is
  flag-independent: it asserts the `features` shape and that the route guards (409 off / 404 for a foreign claim id on).
  A real SetupIntent needs a browser: `eval/web_smoke.py` scenario F (S3).
- Migration `20260928160000_card_on_file.sql`; `check_schema.sql` asserts the four columns, the four-digit check and that
  no card-data column exists. `eval/reset_test_lead.sql` clears the card fields on the synthetic account.
- `GET /ops` claims carry `customers(card_brand, card_last4)` for the drawer's "Card on file · Visa ····4242" line (S3).
  The agent's `get_claim` already returns the whole account row, so `card_on_file` is visible to drafts; the templates do
  not mention it (wording only via M8).
- Stripe's API is not reachable from the Cowork sandbox (ARCHITECTURE §3.2), so the client is verified by fixture tests
  here and by the smoke test on the Vercel preview. Live activation of the Stripe account waits on the LLC (O-06); until
  then the flag is flipped on for a test session and off again the same day (S4).
