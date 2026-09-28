// POST /claim/card (SPEC-03 §4.2): save a card to the claim's account with a server-confirmed SetupIntent. Pure of I/O —
// the route in index.ts passes a `CardStore` (the Supabase reads/writes) and a `StripeClient` so the decision path is
// unit-testable with fakes (card_test.ts). Nothing here charges; SPEC-05 task 6 owns the charge and is guarded there.
import type { SetupIntentResult, StripeClient } from "../_shared/stripe.ts";
import { idempotencyKey } from "../_shared/stripe.ts";

export interface CardAccount { id: string; email: string; full_name: string | null; stripe_customer_id: string | null; card_on_file: boolean }

export interface CardStore {
  findClaim(code: string, claimId: string): Promise<{ id: string; customer_id: string | null } | null>;
  loadAccount(id: string): Promise<CardAccount | null>;
  saveStripeCustomer(accountId: string, stripeCustomerId: string): Promise<void>;
  recordCard(p: { accountId: string; claimId: string; code: string; paymentMethod: string; brand: string | null; last4: string | null; ip: string; ua: string }): Promise<void>;
}

export type CardRequest = { c: string | null; claim: string; confirmation_token?: string; setup_intent?: string };

export type CardResponse =
  | { http: 200; body: { ok: true; status: "succeeded"; last4: string | null; brand: string | null } }
  | { http: 200; body: { ok: true; status: "requires_action"; client_secret: string } }
  | { http: 400 | 404 | 409 | 502; body: { ok: false; error: string; message?: string } };

/** Which of `features` the page reads: the card step mounts only when `card` is true (flag + both keys present). */
export function cardFeatures(env: (k: string) => string | undefined): { card: boolean; stripe_publishable_key: string | null } {
  const on = env("STRIPE_ENABLED") === "true" && !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY");
  return { card: on, stripe_publishable_key: on ? env("STRIPE_PUBLISHABLE_KEY") ?? null : null };
}

export function parseCardBody(body: unknown): CardRequest | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const claim = String(b.claim ?? "").trim();
  const token = typeof b.confirmation_token === "string" ? b.confirmation_token.trim() : "";
  const si = typeof b.setup_intent === "string" ? b.setup_intent.trim() : "";
  if (!claim || (!token && !si)) return null;
  if (token && !/^ctoken_[A-Za-z0-9_]+$/.test(token)) return null;
  if (si && !/^seti_[A-Za-z0-9_]+$/.test(si)) return null;
  return { c: typeof b.c === "string" ? b.c : null, claim, confirmation_token: token || undefined, setup_intent: si || undefined };
}

export async function saveCard(
  req: CardRequest & { c: string }, ctx: { enabled: boolean; ip: string; ua: string; site: string }, store: CardStore, stripe: StripeClient,
): Promise<CardResponse> {
  if (!ctx.enabled) return { http: 409, body: { ok: false, error: "card_disabled" } };
  const claim = await store.findClaim(req.c, req.claim);
  if (!claim || !claim.customer_id) return { http: 404, body: { ok: false, error: "not_found" } };
  const account = await store.loadAccount(claim.customer_id);
  if (!account) return { http: 404, body: { ok: false, error: "not_found" } };

  let result: SetupIntentResult;
  if (req.setup_intent) {
    // second leg after 3-D Secure: the page ran handleNextAction; we read the final state from Stripe, never trust the page
    result = await stripe.retrieveSetupIntent(req.setup_intent);
  } else {
    let customerId = account.stripe_customer_id;
    if (!customerId) {
      const created = await stripe.createCustomer({ email: account.email, name: account.full_name ?? "", metadata: { customer_id: account.id, claim_code: req.c } });
      if ("status" in created) return { http: 502, body: { ok: false, error: created.error, message: created.message } };
      customerId = created.id;
      await store.saveStripeCustomer(account.id, customerId);
    }
    result = await stripe.createAndConfirmSetupIntent({
      customer: customerId, confirmationToken: req.confirmation_token!, metadata: { claim_id: claim.id, claim_code: req.c },
      returnUrl: `${ctx.site}/claim/${req.c}/status`, idempotencyKey: await idempotencyKey(claim.id, req.confirmation_token!),
    });
  }

  if (result.status === "succeeded") {
    await store.recordCard({ accountId: account.id, claimId: claim.id, code: req.c, paymentMethod: result.payment_method, brand: result.brand, last4: result.last4, ip: ctx.ip, ua: ctx.ua });
    return { http: 200, body: { ok: true, status: "succeeded", last4: result.last4, brand: result.brand } };
  }
  if (result.status === "requires_action") return { http: 200, body: { ok: true, status: "requires_action", client_secret: result.client_secret } };
  return { http: 400, body: { ok: false, error: result.error, message: result.message } };
}
