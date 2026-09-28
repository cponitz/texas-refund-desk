// Stripe over plain fetch (SPEC-03, ADR 0021): three calls, form-encoded, no SDK — the same way the functions talk to
// Anthropic, Resend and Lob. The browser never creates or confirms a SetupIntent: it hands the server a confirmation
// token from the Payment Element and the server confirms, so every saved card is tied to a known claim and account.
// Nothing here ever sees a card number, expiry or CVC (those stay inside Stripe's iframe); the logger still strips any
// long digit run and every value except an allowlist of ids, in case a future caller passes something it shouldn't.
//
//   createCustomer               POST /v1/customers                              -> {id}
//   createAndConfirmSetupIntent  POST /v1/setup_intents (confirm=true, token)    -> SetupIntentResult
//   retrieveSetupIntent          GET  /v1/setup_intents/:id                      -> SetupIntentResult   (after 3-D Secure)
//
// Pinned API version: see STRIPE_VERSION. Bump it deliberately (ADR 0021), never by default.

export const STRIPE_VERSION = "2025-09-30.clover";
const BASE = "https://api.stripe.com";

export type Params = Record<string, unknown>;

/** Stripe's form encoding: nested objects as `a[b]`, arrays as `a[0]`, `a[1]`; null/undefined dropped. */
export function formEncode(params: Params, prefix = ""): string {
  const parts: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Params)) walk(x, key ? `${key}[${k}]` : k);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  walk(params, prefix);
  return parts.join("&");
}

/** What a log line may say about a request: key names, an allowlist of Stripe ids, and never a run of 12+ digits. */
const LOG_VALUE_ALLOW = new Set(["customer", "usage", "confirm", "setup_intent", "payment_method", "return_url", "expand"]);
export function redactForLog(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  const flat = (v: unknown, key: string) => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Params)) flat(x, key ? `${key}.${k}` : k); return; }
    const root = key.split(".")[0];
    out[key] = LOG_VALUE_ALLOW.has(root) ? String(v).replace(/\d{12,}/g, "[redacted]") : "[redacted]";
  };
  flat(params, "");
  return out;
}

export type SetupIntentResult =
  | { status: "succeeded"; setup_intent: string; payment_method: string; brand: string | null; last4: string | null }
  | { status: "requires_action"; setup_intent: string; client_secret: string }
  | { status: "failed"; error: "card_declined" | "stripe_error"; message: string; code: string | null };

/** The customer-facing message only; Stripe's `message` is written for the payer, `code` is for our logs. */
export function mapStripeError(body: unknown): Extract<SetupIntentResult, { status: "failed" }> {
  const err = ((body as { error?: Record<string, unknown> } | null)?.error ?? {}) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : (typeof err.decline_code === "string" ? err.decline_code : null);
  const declined = err.type === "card_error" || code === "card_declined";
  const message = typeof err.message === "string" && err.message ? err.message : "Something went wrong with the payment provider.";
  return { status: "failed", error: declined ? "card_declined" : "stripe_error", message, code };
}

/** A SetupIntent object (with `payment_method` expanded) → what the route needs. Unknown / cancelled statuses fail closed. */
export function mapSetupIntent(si: unknown): SetupIntentResult {
  const s = (si ?? {}) as Record<string, unknown>;
  const pm = s.payment_method;
  const pmId = typeof pm === "string" ? pm : typeof (pm as Record<string, unknown> | undefined)?.id === "string" ? String((pm as Record<string, unknown>).id) : "";
  const card = (typeof pm === "object" && pm ? (pm as Record<string, unknown>).card : null) as Record<string, unknown> | null;
  const last4 = card && /^\d{4}$/.test(String(card.last4 ?? "")) ? String(card.last4) : null;
  const brand = card && typeof card.brand === "string" ? card.brand : null;
  if (s.status === "succeeded" && pmId) return { status: "succeeded", setup_intent: String(s.id ?? ""), payment_method: pmId, brand, last4 };
  if (s.status === "requires_action" && typeof s.client_secret === "string") return { status: "requires_action", setup_intent: String(s.id ?? ""), client_secret: s.client_secret };
  if (s.last_setup_error) return mapStripeError({ error: s.last_setup_error });
  return { status: "failed", error: "stripe_error", message: "We couldn't save that card.", code: typeof s.status === "string" ? `status_${s.status}` : null };
}

/** `card:<claim_id>:<sha256(token)[:16]>` — a retried POST with the same token confirms once (SPEC-03 §4.2 step 3). */
export async function idempotencyKey(claimId: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `card:${claimId}:${hex.slice(0, 16)}`;
}

export interface StripeClient {
  createCustomer(p: { email: string; name: string; metadata: Record<string, string> }): Promise<{ id: string } | Extract<SetupIntentResult, { status: "failed" }>>;
  createAndConfirmSetupIntent(p: { customer: string; confirmationToken: string; metadata: Record<string, string>; returnUrl: string; idempotencyKey: string }): Promise<SetupIntentResult>;
  retrieveSetupIntent(id: string): Promise<SetupIntentResult>;
}

async function call(secret: string, method: "GET" | "POST", path: string, params: Params, idem?: string): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}`, "stripe-version": STRIPE_VERSION };
  let url = `${BASE}${path}`, body: string | undefined;
  if (method === "GET") { const q = formEncode(params); if (q) url += `?${q}`; }
  else { headers["content-type"] = "application/x-www-form-urlencoded"; body = formEncode(params); if (idem) headers["idempotency-key"] = idem; }
  const res = await fetch(url, { method, headers, body });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (json as { error?: { code?: string; type?: string } } | null)?.error;
    console.error("stripe", method, path, res.status, e?.type ?? "", e?.code ?? "", JSON.stringify(redactForLog(params)));   // never the request body
  }
  return { ok: res.ok, body: json };
}

export function stripeClient(secret: string): StripeClient {
  return {
    async createCustomer({ email, name, metadata }) {
      const r = await call(secret, "POST", "/v1/customers", { email, name, metadata });
      if (!r.ok) return mapStripeError(r.body);
      const id = (r.body as { id?: string } | null)?.id;
      return id ? { id } : { status: "failed", error: "stripe_error", message: "Something went wrong with the payment provider.", code: "no_customer_id" };
    },
    async createAndConfirmSetupIntent({ customer, confirmationToken, metadata, returnUrl, idempotencyKey }) {
      const r = await call(secret, "POST", "/v1/setup_intents", {
        customer, confirm: "true", confirmation_token: confirmationToken, usage: "off_session",
        automatic_payment_methods: { enabled: "true", allow_redirects: "never" }, metadata, return_url: returnUrl, expand: ["payment_method"],
      }, idempotencyKey);
      return r.ok ? mapSetupIntent(r.body) : mapStripeError(r.body);
    },
    async retrieveSetupIntent(id) {
      const r = await call(secret, "GET", `/v1/setup_intents/${encodeURIComponent(id)}`, { expand: ["payment_method"] });
      return r.ok ? mapSetupIntent(r.body) : mapStripeError(r.body);
    },
  };
}
