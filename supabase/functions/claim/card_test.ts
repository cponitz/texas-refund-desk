import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CardAccount, type CardStore, cardFeatures, parseCardBody, saveCard } from "./card.ts";
import type { SetupIntentResult, StripeClient } from "../_shared/stripe.ts";

const CODE = "CB-TEST-0001", CLAIM = "c1", OTHER = "c2";
const ctx = { enabled: true, ip: "203.0.113.7", ua: "test", site: "https://cleanbillco.com" };

function fakeStore(account: Partial<CardAccount> = {}) {
  const acct: CardAccount = { id: "a1", email: "selftest@example.com", full_name: "Richard L Garcia", stripe_customer_id: null, card_on_file: false, ...account };
  const writes: Array<Record<string, unknown>> = [];
  const store: CardStore = {
    findClaim: (code, claimId) => Promise.resolve(code === CODE && claimId === CLAIM ? { id: CLAIM, customer_id: "a1" } : null),
    loadAccount: (id) => Promise.resolve(id === acct.id ? acct : null),
    saveStripeCustomer: (accountId, stripeCustomerId) => { writes.push({ op: "stripe_customer", accountId, stripeCustomerId }); acct.stripe_customer_id = stripeCustomerId; return Promise.resolve(); },
    recordCard: (p) => { writes.push({ op: "card", ...p }); return Promise.resolve(); },
  };
  return { store, writes, acct };
}

function fakeStripe(confirm: SetupIntentResult, retrieve?: SetupIntentResult) {
  const calls: Array<Record<string, unknown>> = [];
  const stripe: StripeClient = {
    createCustomer: (p) => { calls.push({ op: "customer", ...p }); return Promise.resolve({ id: "cus_new" }); },
    createAndConfirmSetupIntent: (p) => { calls.push({ op: "confirm", ...p }); return Promise.resolve(confirm); },
    retrieveSetupIntent: (id) => { calls.push({ op: "retrieve", id }); return Promise.resolve(retrieve ?? confirm); },
  };
  return { stripe, calls };
}

const ok: SetupIntentResult = { status: "succeeded", setup_intent: "seti_1", payment_method: "pm_1", brand: "visa", last4: "4242" };

Deno.test("features: card is on only with the flag and both keys; the publishable key is served only then (SPEC-03 §4.1)", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(cardFeatures(env({})), { card: false, stripe_publishable_key: null });
  assertEquals(cardFeatures(env({ STRIPE_ENABLED: "true", STRIPE_PUBLISHABLE_KEY: "pk_test_1" })), { card: false, stripe_publishable_key: null });   // no secret key
  assertEquals(cardFeatures(env({ STRIPE_ENABLED: "false", STRIPE_SECRET_KEY: "sk", STRIPE_PUBLISHABLE_KEY: "pk_test_1" })), { card: false, stripe_publishable_key: null });
  assertEquals(cardFeatures(env({ STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk", STRIPE_PUBLISHABLE_KEY: "pk_test_1" })), { card: true, stripe_publishable_key: "pk_test_1" });
});

Deno.test("body parsing: claim plus a confirmation token or a setup intent id, shapes checked", () => {
  assertEquals(parseCardBody({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_abc" }), { c: CODE, claim: CLAIM, confirmation_token: "ctoken_abc", setup_intent: undefined });
  assertEquals(parseCardBody({ c: CODE, claim: CLAIM, setup_intent: "seti_abc" })?.setup_intent, "seti_abc");
  assertEquals(parseCardBody({ c: CODE, claim: CLAIM }), null);
  assertEquals(parseCardBody({ c: CODE, claim: CLAIM, confirmation_token: "4242424242424242" }), null);
  assertEquals(parseCardBody(null), null);
});

Deno.test("flag off -> 409 card_disabled before any lookup or Stripe call (acceptance §8.6)", async () => {
  const { store } = fakeStore(); const { stripe, calls } = fakeStripe(ok);
  const r = await saveCard({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_a" }, { ...ctx, enabled: false }, store, stripe);
  assertEquals([r.http, r.body], [409, { ok: false, error: "card_disabled" }]);
  assertEquals(calls.length, 0);
});

Deno.test("code / claim mismatch -> 404, nothing written, nothing sent to Stripe", async () => {
  const { store, writes } = fakeStore(); const { stripe, calls } = fakeStripe(ok);
  const r = await saveCard({ c: CODE, claim: OTHER, confirmation_token: "ctoken_a" }, ctx, store, stripe);
  assertEquals([r.http, r.body], [404, { ok: false, error: "not_found" }]);
  assertEquals([writes.length, calls.length], [0, 0]);
});

Deno.test("first card: Stripe Customer created with account metadata, SetupIntent confirmed off-session with the idempotency key, card recorded, card_saved via the store", async () => {
  const { store, writes, acct } = fakeStore(); const { stripe, calls } = fakeStripe(ok);
  const r = await saveCard({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_a" }, ctx, store, stripe);
  assertEquals([r.http, r.body], [200, { ok: true, status: "succeeded", last4: "4242", brand: "visa" }]);
  assertEquals(calls[0], { op: "customer", email: "selftest@example.com", name: "Richard L Garcia", metadata: { customer_id: "a1", claim_code: CODE } });
  const confirm = calls[1] as Record<string, unknown>;
  assertEquals([confirm.op, confirm.customer, confirm.confirmationToken, confirm.returnUrl, confirm.metadata], ["confirm", "cus_new", "ctoken_a", `https://cleanbillco.com/claim/${CODE}/status`, { claim_id: CLAIM, claim_code: CODE }]);
  assert(/^card:c1:[0-9a-f]{16}$/.test(String(confirm.idempotencyKey)));
  assertEquals(acct.stripe_customer_id, "cus_new");
  assertEquals(writes[0], { op: "stripe_customer", accountId: "a1", stripeCustomerId: "cus_new" });
  assertEquals(writes[1], { op: "card", accountId: "a1", claimId: CLAIM, code: CODE, paymentMethod: "pm_1", brand: "visa", last4: "4242", ip: ctx.ip, ua: ctx.ua });
  assert(!JSON.stringify([writes, r]).includes("4242424242424242"));
});

Deno.test("second claim by the same e-mail reuses the Stripe Customer: no second POST /v1/customers (acceptance §8.3)", async () => {
  const { store, writes } = fakeStore({ stripe_customer_id: "cus_existing", card_on_file: true }); const { stripe, calls } = fakeStripe(ok);
  const r = await saveCard({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_b" }, ctx, store, stripe);
  assertEquals(r.http, 200);
  assertEquals(calls.map((c) => c.op), ["confirm"]);
  assertEquals((calls[0] as { customer: string }).customer, "cus_existing");
  assertEquals(writes.map((w) => w.op), ["card"]);
});

Deno.test("requires_action returns the client secret and writes nothing; the second leg retrieves the intent and records the card", async () => {
  const { store, writes } = fakeStore({ stripe_customer_id: "cus_x" });
  const { stripe, calls } = fakeStripe({ status: "requires_action", setup_intent: "seti_9", client_secret: "seti_9_secret" }, ok);
  const r1 = await saveCard({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_c" }, ctx, store, stripe);
  assertEquals([r1.http, r1.body], [200, { ok: true, status: "requires_action", client_secret: "seti_9_secret" }]);
  assertEquals(writes.length, 0);
  const r2 = await saveCard({ c: CODE, claim: CLAIM, setup_intent: "seti_9" }, ctx, store, stripe);
  assertEquals([r2.http, (r2.body as { status: string }).status], [200, "succeeded"]);
  assertEquals(calls.map((c) => c.op), ["confirm", "retrieve"]);
  assertEquals(writes.map((w) => w.op), ["card"]);
});

Deno.test("a declined card is 400 card_declined with Stripe's payer-facing message and nothing recorded", async () => {
  const { store, writes } = fakeStore({ stripe_customer_id: "cus_x" });
  const { stripe } = fakeStripe({ status: "failed", error: "card_declined", message: "Your card was declined.", code: "card_declined" });
  const r = await saveCard({ c: CODE, claim: CLAIM, confirmation_token: "ctoken_d" }, ctx, store, stripe);
  assertEquals([r.http, r.body], [400, { ok: false, error: "card_declined", message: "Your card was declined." }]);
  assertEquals(writes.length, 0);
});
