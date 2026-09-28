import { assert, assertEquals } from "jsr:@std/assert@1";
import { formEncode, idempotencyKey, mapSetupIntent, mapStripeError, redactForLog, STRIPE_VERSION } from "./stripe.ts";

const pm = { id: "pm_1", object: "payment_method", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2034 } };

Deno.test("form encoder: nested keys, arrays, booleans as strings, nulls dropped, values escaped (SPEC-03 §4.2 step 5)", () => {
  const q = formEncode({ customer: "cus_1", confirm: "true", automatic_payment_methods: { enabled: "true", allow_redirects: "never" }, metadata: { claim_code: "CB-TEST-0001", note: null }, expand: ["payment_method"], email: "a+b@x.co" });
  assertEquals(q, "customer=cus_1&confirm=true&automatic_payment_methods%5Benabled%5D=true&automatic_payment_methods%5Ballow_redirects%5D=never&metadata%5Bclaim_code%5D=CB-TEST-0001&expand%5B0%5D=payment_method&email=a%2Bb%40x.co");
  assertEquals(formEncode({}), "");
});

Deno.test("setup intent mapping: succeeded carries brand + last4 + payment method; requires_action carries the client secret; anything else fails closed", () => {
  assertEquals(mapSetupIntent({ id: "seti_1", status: "succeeded", payment_method: pm }), { status: "succeeded", setup_intent: "seti_1", payment_method: "pm_1", brand: "visa", last4: "4242" });
  assertEquals(mapSetupIntent({ id: "seti_1", status: "succeeded", payment_method: "pm_9" }), { status: "succeeded", setup_intent: "seti_1", payment_method: "pm_9", brand: null, last4: null });   // unexpanded
  assertEquals(mapSetupIntent({ id: "seti_2", status: "requires_action", client_secret: "seti_2_secret_x" }), { status: "requires_action", setup_intent: "seti_2", client_secret: "seti_2_secret_x" });
  const canceled = mapSetupIntent({ id: "seti_3", status: "canceled" });
  assertEquals([canceled.status, (canceled as { error: string }).error, (canceled as { code: string }).code], ["failed", "stripe_error", "status_canceled"]);
  const declined = mapSetupIntent({ id: "seti_4", status: "requires_payment_method", last_setup_error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." } });
  assertEquals(declined, { status: "failed", error: "card_declined", message: "Your card was declined.", code: "card_declined" });
  assertEquals(mapSetupIntent(null).status, "failed");
  assertEquals(mapSetupIntent({ status: "succeeded", payment_method: { id: "pm_1", card: { last4: "42" } } }).status, "succeeded");   // a malformed last4 becomes null, never stored
  assertEquals((mapSetupIntent({ status: "succeeded", payment_method: { id: "pm_1", card: { last4: "42" } } }) as { last4: string | null }).last4, null);
});

Deno.test("stripe error mapping: card errors are card_declined with Stripe's payer-facing message; the rest are stripe_error with a fallback message", () => {
  assertEquals(mapStripeError({ error: { type: "card_error", code: "incorrect_cvc", message: "Your card's security code is incorrect." } }), { status: "failed", error: "card_declined", message: "Your card's security code is incorrect.", code: "incorrect_cvc" });
  assertEquals(mapStripeError({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such confirmation token" } }).error, "stripe_error");
  assertEquals(mapStripeError({ error: { type: "api_error" } }).message, "Something went wrong with the payment provider.");
  assertEquals(mapStripeError(null).error, "stripe_error");
});

Deno.test("logger redaction: only allowlisted ids keep their value, long digit runs are masked, nothing card-shaped survives (acceptance §8.4)", () => {
  const r = redactForLog({ customer: "cus_1", confirmation_token: "ctoken_secret", metadata: { claim_code: "CB-TEST-0001" }, email: "a@b.co", card: { number: "4242424242424242", cvc: "123", exp_month: "12" }, return_url: "https://cleanbillco.com/claim/CB-TEST-0001/status" });
  assertEquals(r.customer, "cus_1");
  assertEquals(r.return_url, "https://cleanbillco.com/claim/CB-TEST-0001/status");
  for (const k of ["confirmation_token", "metadata.claim_code", "email", "card.number", "card.cvc", "card.exp_month"]) assertEquals(r[k], "[redacted]", k);
  const line = JSON.stringify(r);
  assert(!/\d{12,}/.test(line) && !line.includes("123") && !line.includes("ctoken_secret") && !line.includes("a@b.co"));
  assertEquals(redactForLog({ customer: "cus_4242424242424242x" }).customer, "cus_[redacted]x");
});

Deno.test("idempotency key is card:<claim>:<sha256(token)[:16]>, stable and token-specific; API version pinned", async () => {
  const a = await idempotencyKey("11111111-1111-1111-1111-111111111111", "ctoken_a"), b = await idempotencyKey("11111111-1111-1111-1111-111111111111", "ctoken_a"), c = await idempotencyKey("11111111-1111-1111-1111-111111111111", "ctoken_b");
  assertEquals(a, b);
  assert(a !== c);
  assert(/^card:11111111-1111-1111-1111-111111111111:[0-9a-f]{16}$/.test(a));
  assert(/^\d{4}-\d{2}-\d{2}\./.test(STRIPE_VERSION));
});
