// Claim API (JSON). The page itself is static (docs/claim.html today; apps/web on Vercel after SPEC-04b) because Supabase
// forces text/plain + a sandbox CSP on anything served from *.supabase.co. Auth is the unguessable claim code; CORS is
// open (the code is the secret). verify_jwt is off. Data model v2 (SPEC-04): the person is a `customers` account matched
// by e-mail (citext); the engagement is a `claims` row with customer_id.
//
//   GET  /claim?c=CODE                     -> lead + property JSON (logs a view, marks the lead opened). When the lead is
//                                             already claimed, includes the current claim's status + rendered findings so
//                                             the page can show the fix screen (SPEC-02 §1).
//   GET  /claim?c=CODE&claim=<uuid>        -> {status, findings[], packet_url?} — the inline-validation poll (SPEC-06 §2)
//   GET  /claim/precheck?c&address&zip     -> {match, id_address, situs} — typed address pre-check (SPEC-06 §3)
//   POST /claim/events {c, kind, detail}   -> funnel event from the page (SPEC-06 §5)
//   POST /claim/reply {c, claim, body}     -> the customer's answer to a needs_review question: an inbound `messages` row (SPEC-06 §2)
//   POST /claim/card {c, claim, confirmation_token | setup_intent}
//                                          -> save a card to the claim's account: server-confirmed Stripe SetupIntent (SPEC-03 §4.2,
//                                             ADR 0021); only while STRIPE_ENABLED=true (else 409). Never charges. GET responses carry
//                                             `features {card, stripe_publishable_key}` so the page knows whether to show the step.
//   POST /claim/inquiry {kind, ...}        -> a public-site form (address check, exemption/appeal check, business portfolio
//                                             review): an `inquiries` row we answer by e-mail (SPEC-07). No claim code.
//   POST /claim (multipart)                -> new claim: eligibility answers, ID upload(s), contact, consents, typed signature,
//                                             optional typed_* pre-check fields (stored as a `typed_id` document);
//                                             for a code already claimed: re-upload (needs_dl_update + dl_front, SPEC-02 §2)
//                                             or typed confirmation (needs_review + typed_* fields, SPEC-06 §4); anything
//                                             else is 409.
// Every sentence a person reads comes from the generated rule table (_shared/findings.ts, ADR 0016).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clientIp, serviceClient } from "./db.ts";
import { type Finding, makeFinding, reasonText, renderForCustomer } from "../_shared/findings.ts";
import type { Extracted, PropertyRec } from "../_shared/validate.ts";
import { cardFeatures, parseCardBody, saveCard } from "./card.ts";
import { stripeClient } from "../_shared/stripe.ts";
import { SITE } from "../_shared/brand.ts";
import { extFor, followUpMode, isPageEvent, PAGE_EVENTS, parseInquiry, parseTypedFields, precheck, timelineFrom, TYPED_FALLBACK_CODES, typedExtracted } from "./logic.ts";

type SB = ReturnType<typeof serviceClient>;

const CODE_PREFIX = "CB";   // SPEC-08 A2 (B-19): codes are CB-XXXX-XXXX; TRD- codes are rejected (nothing was printed or mailed)
const CODE_RE = /^CB-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_BYTES = 15 * 1024 * 1024;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);   // HEIC is converted client-side (SPEC-04b) — the extraction model does not accept it
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};
const OPEN = ["new", "mailed", "opened"];
const env = (k: string) => Deno.env.get(k);
const features = () => cardFeatures(env);   // SPEC-03 §4.1: flag + publishable key served by the API, one home (function secrets)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}

export function normCode(raw: string | null): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const n = CODE_PREFIX.length;
  if (c.length !== n + 8 || !c.startsWith(CODE_PREFIX)) return null;
  const code = `${CODE_PREFIX}-${c.slice(n, n + 4)}-${c.slice(n + 4, n + 8)}`;
  return CODE_RE.test(code) ? code : null;
}

async function loadLead(sb: SB, code: string) {
  const { data: lead } = await sb.from("leads").select("*").eq("claim_code", code).maybeSingle();
  if (!lead) return null;
  const { data: prop } = await sb.from("properties")
    .select("prop_id, owner_name, situs_num, situs_street, situs_unit, situs_city, situs_zip, situs_full").eq("prop_id", lead.prop_id).single();
  if (!prop) return null;
  return { lead, prop: prop as PropertyRec };
}

/** 120 counted requests per IP per hour (ADR 0008). `kinds` are the event kinds that count against the budget. */
async function rateLimited(sb: SB, ip: string, kinds: string[] = ["view"], limit = 120): Promise<boolean> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb.from("events").select("id", { count: "exact", head: true })
    .in("kind", kinds).gte("at", since).contains("detail", { ip });
  return (count ?? 0) > limit;
}

function inBackground(p: PromiseLike<unknown>) {
  const promise = Promise.resolve(p).catch((e) => console.error("background task failed", e));   // supabase-js builders are thenables, not Promises
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(promise);
}

function kickProcessClaim(body: Record<string, unknown>) {
  inBackground(fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(body),
  }).catch((e) => console.error("process-claim kick failed", e)));
}

/** The claim as the page sees it: status, findings rendered for the customer, a 10-minute packet link when ready, and —
 *  for an unreadable / low-confidence photo — what the model read so the page can pre-fill the typed confirmation (SPEC-06 §4). */
const PACKET_STATUSES = new Set(["ready_to_submit", "filed", "approved", "refunded", "paid"]);   // the packet exists and is the customer's to see (SPEC-07 portal: "Form 50-114 (as submitted)")

async function claimSummary(sb: SB, c: { id: string; status: string; findings: unknown }) {
  const raw = Array.isArray(c.findings) ? c.findings as Finding[] : [];
  const findings = raw.map(renderForCustomer);
  let packet_url: string | null = null;
  if (PACKET_STATUSES.has(c.status)) {
    const { data: fil } = await sb.from("filings").select("packet_path").eq("claim_id", c.id).order("generated_at", { ascending: false }).limit(1).maybeSingle();
    if (fil?.packet_path) {
      const { data: s } = await sb.storage.from("packets").createSignedUrl(fil.packet_path, 600);
      packet_url = s?.signedUrl ?? null;
    }
  }
  let typed_prefill: Record<string, string> | null = null;
  if (c.status === "needs_review" && raw.some((f) => TYPED_FALLBACK_CODES.includes(String(f.code)))) {
    const { data: d } = await sb.from("documents").select("extracted").eq("claim_id", c.id).eq("kind", "dl_front").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const ex = (d?.extracted ?? {}) as Record<string, unknown>;
    typed_prefill = {};
    for (const k of ["first_name", "last_name", "dob", "address_line1", "city", "zip"]) typed_prefill[k] = String(ex[k] ?? "");   // never the DL number
  }
  return { id: c.id, status: c.status, findings, packet_url, typed_prefill };
}

async function latestClaimForLead(sb: SB, leadId: string) {
  const { data } = await sb.from("claims").select("id, status, findings, full_name, customer_id, created_at").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data;
}

/** What the portal page (SPEC-07 §10, `/claim/[code]/status`) shows beyond the summary: the customer's first name, the
 *  card-on-file flag, the dated timeline and the real (sent or received) messages — never agent drafts, never the DL. */
async function portalSummary(sb: SB, c: { id: string; status: string; findings: unknown; full_name?: string | null; customer_id?: string | null; created_at?: string | null }) {
  const summary = await claimSummary(sb, c);
  const [{ data: fil }, { data: processed }, { data: msgs }, { data: acct }] = await Promise.all([
    sb.from("filings").select("id, submitted_at, approved_at, denied_at").eq("claim_id", c.id).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("audit_log").select("at").eq("entity", "claims").eq("entity_id", c.id).eq("actor", "process-claim").eq("action", "processed").order("at", { ascending: true }).limit(1).maybeSingle(),
    sb.from("messages").select("subject, direction, sent_at, created_at").eq("claim_id", c.id).eq("agent_draft", false).order("created_at", { ascending: false }).limit(10),
    c.customer_id ? sb.from("customers").select("card_on_file").eq("id", c.customer_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  let refund_observed_at: string | null = null;
  if (fil?.id) {
    const { data: r } = await sb.from("refunds").select("observed_at").eq("filing_id", fil.id).not("observed_at", "is", null).order("observed_at", { ascending: true }).limit(1).maybeSingle();
    refund_observed_at = r?.observed_at ?? null;
  }
  const messages = (msgs ?? []).filter((m) => m.direction === "inbound" || m.sent_at).map((m) => ({ subject: m.subject ?? "", direction: m.direction, at: m.sent_at ?? m.created_at }));
  return {
    ...summary,
    first_name: (c.full_name ?? "").split(" ")[0] || null,
    card_on_file: !!(acct as { card_on_file?: boolean } | null)?.card_on_file,
    timeline: timelineFrom({ created_at: c.created_at ?? null, processed_at: processed?.at ?? null, filing: fil ? { submitted_at: fil.submitted_at, approved_at: fil.approved_at, denied_at: fil.denied_at } : null, refund_observed_at }),
    messages,
  };
}

function validFile(f: unknown): f is File {
  return f instanceof File && f.size > 0 && f.size <= MAX_BYTES && MIMES.has(f.type);
}

async function storeUpload(sb: SB, claimId: string, kind: string, file: File, suffix: string): Promise<string | null> {
  const path = `${claimId}/${kind}${suffix}.${extFor(file.type)}`;
  const { error } = await sb.storage.from("ids").upload(path, file, { contentType: file.type, upsert: true });
  if (error) return null;
  await sb.from("documents").insert({ claim_id: claimId, kind, storage_path: path, mime: file.type, bytes: file.size });
  return path;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const sb = serviceClient();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";

  // ---- GET /claim/precheck?c&address&zip -------------------------------------------------------------------------
  if (req.method === "GET" && path.endsWith("/precheck")) {
    const code = normCode(url.searchParams.get("c"));
    if (!code) return json({ ok: false, error: "not_found" }, 404);
    if (await rateLimited(sb, ip, ["view", "typed_precheck"])) return json({ ok: false, error: "rate_limited" }, 429);
    const found = await loadLead(sb, code);
    if (!found) return json({ ok: false, error: "not_found" }, 404);
    const r = precheck(url.searchParams.get("address"), url.searchParams.get("zip"), found.prop);
    inBackground(sb.from("events").insert({ claim_code: code, kind: "typed_precheck", detail: { ip, ua, match: r.match, address: r.id_address } }));
    return json({ ok: true, ...r });
  }

  // ---- GET /claim?c[&claim] -------------------------------------------------------------------------------------
  if (req.method === "GET") {
    const code = normCode(url.searchParams.get("c"));
    if (!code) return json({ ok: false, error: "not_found" }, 404);
    if (await rateLimited(sb, ip)) return json({ ok: false, error: "rate_limited" }, 429);
    const found = await loadLead(sb, code);
    if (!found) {
      await sb.from("events").insert({ claim_code: code, kind: "view_miss", detail: { ip, ua } });
      return json({ ok: false, error: "not_found" }, 404);
    }
    const { lead, prop } = found;

    // the inline-validation poll: no view event, no lead transition — just the claim's state
    const claimId = url.searchParams.get("claim");
    if (claimId) {
      const { data: c } = await sb.from("claims").select("id, status, findings").eq("id", claimId).eq("lead_id", lead.id).maybeSingle();
      if (!c) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, ...(await claimSummary(sb, c)), features: features() });
    }

    await sb.from("events").insert({ claim_code: code, kind: "view", detail: { ip, ua } });
    if (lead.status === "new" || lead.status === "mailed") {
      await sb.from("leads").update({ status: "opened", opened_at: new Date().toISOString() }).eq("id", lead.id).in("status", ["new", "mailed"]);
    }
    const years = (lead.refund_years ?? []).slice().sort();
    if (!OPEN.includes(lead.status)) {
      // Closed leads still return the situs + years so the agreement page can render (the code is the secret); a claimed
      // lead also returns its claim so the page can show the fix screen / status (SPEC-02 §1, SPEC-04b status page).
      const c = lead.status === "claimed" ? await latestClaimForLead(sb, lead.id) : null;
      return json({
        ok: false, error: "closed", status: lead.status, property: { situs_full: prop.situs_full },
        lead: { refund_years: years, est_refund_total: Number(lead.est_refund_total), est_refund_by_year: lead.est_refund_by_year, est_forward_annual: Number(lead.est_forward_annual) },
        claim: c ? await portalSummary(sb, c) : null,
        features: features(),
      });
    }
    const earliest = years[0] ?? new Date().getFullYear() - 2;
    return json({
      ok: true,
      lead: { claim_code: lead.claim_code, refund_years: years, est_refund_total: Number(lead.est_refund_total), est_refund_by_year: lead.est_refund_by_year,
              est_forward_annual: Number(lead.est_forward_annual), tier: lead.tier },
      property: { prop_id: prop.prop_id, owner_name: prop.owner_name, situs_full: prop.situs_full },
      earliest_year: earliest, deadline: `February 1, ${earliest + 3}`,
      features: features(),
    });
  }

  // ---- POST /claim/events {c, kind, detail} ----------------------------------------------------------------------
  if (req.method === "POST" && path.endsWith("/events")) {
    const body = await req.json().catch(() => null) as { c?: string; kind?: string; detail?: unknown } | null;
    const code = normCode(body?.c ?? null);
    const kind = String(body?.kind ?? "");
    if (!code || !isPageEvent(kind)) return json({ ok: false, error: "bad_request" }, 400);
    if (await rateLimited(sb, ip, [...PAGE_EVENTS], 300)) return json({ ok: false, error: "rate_limited" }, 429);
    const found = await loadLead(sb, code);
    if (!found) return json({ ok: false, error: "not_found" }, 404);
    const raw = body?.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail as Record<string, unknown> : {};
    const detail: Record<string, unknown> = { ...raw, ip, ua, source: "page" };
    if (JSON.stringify(detail).length > 2048) return json({ ok: false, error: "bad_request" }, 400);
    await sb.from("events").insert({ claim_code: code, kind, detail });
    return json({ ok: true });
  }

  // ---- POST /claim/reply {c, claim, body} ------------------------------------------------------------------------
  if (req.method === "POST" && path.endsWith("/reply")) {
    const body = await req.json().catch(() => null) as { c?: string; claim?: string; body?: string } | null;
    const code = normCode(body?.c ?? null);
    const text = String(body?.body ?? "").trim().slice(0, 2000);
    const claimId = String(body?.claim ?? "");
    if (!code || !claimId || !text) return json({ ok: false, error: "bad_request" }, 400);
    if (await rateLimited(sb, ip, ["view"])) return json({ ok: false, error: "rate_limited" }, 429);
    const found = await loadLead(sb, code);
    if (!found) return json({ ok: false, error: "not_found" }, 404);
    const { data: c } = await sb.from("claims").select("id, status").eq("id", claimId).eq("lead_id", found.lead.id).maybeSingle();
    if (!c) return json({ ok: false, error: "not_found" }, 404);
    const { data: m, error } = await sb.from("messages").insert({ claim_id: c.id, direction: "inbound", channel: "portal", intent: "reply", subject: "Reply from the claim page", body: text, agent_draft: false }).select("id").single();
    if (error || !m) return json({ ok: false, error: "server_error" }, 500);
    await sb.from("audit_log").insert({ actor: "claim-api", action: "customer_reply", entity: "messages", entity_id: m.id, detail: { code, claim_id: c.id, status: c.status, chars: text.length } });
    return json({ ok: true, message_id: m.id });
  }

  // ---- POST /claim/card {c, claim, confirmation_token | setup_intent} (SPEC-03) -------------------------------------
  // The card step's one call. Every attempt is counted (`card_attempt`) for a 10/IP/hour limit; the page only sees Stripe's
  // customer-facing message; the request body is never logged. `card_saved` is written here, not by the page.
  if (req.method === "POST" && path.endsWith("/card")) {
    const parsed = parseCardBody(await req.json().catch(() => null));
    const code = normCode(parsed?.c ?? null);
    if (!parsed || !code) return json({ ok: false, error: "bad_request" }, 400);
    if (await rateLimited(sb, ip, ["card_attempt"], 10)) return json({ ok: false, error: "rate_limited" }, 429);
    inBackground(sb.from("events").insert({ claim_code: code, kind: "card_attempt", detail: { ip, ua, claim_id: parsed.claim, source: "api", leg: parsed.setup_intent ? "after_action" : "confirm" } }));
    const store = {
      async findClaim(c: string, claimId: string) {
        const found = await loadLead(sb, c);
        if (!found) return null;
        const { data } = await sb.from("claims").select("id, customer_id").eq("id", claimId).eq("lead_id", found.lead.id).maybeSingle();
        return data ?? null;
      },
      async loadAccount(id: string) {
        const { data } = await sb.from("customers").select("id, email, full_name, stripe_customer_id, card_on_file").eq("id", id).maybeSingle();
        return data ?? null;
      },
      async saveStripeCustomer(accountId: string, stripeCustomerId: string) {
        await sb.from("customers").update({ stripe_customer_id: stripeCustomerId }).eq("id", accountId);
      },
      async recordCard(p: { accountId: string; claimId: string; code: string; paymentMethod: string; brand: string | null; last4: string | null; ip: string; ua: string }) {
        await sb.from("customers").update({ card_on_file: true, card_brand: p.brand, card_last4: p.last4, card_consented_at: new Date().toISOString(), stripe_payment_method_id: p.paymentMethod }).eq("id", p.accountId);
        await sb.from("events").insert({ claim_code: p.code, kind: "card_saved", detail: { ip: p.ip, ua: p.ua, claim_id: p.claimId, source: "api", brand: p.brand, last4: p.last4 } });
        await sb.from("audit_log").insert({ actor: "claim-api", action: "card_saved", entity: "customers", entity_id: p.accountId, detail: { code: p.code, claim_id: p.claimId, brand: p.brand, last4: p.last4, payment_method: p.paymentMethod } });
      },
    };
    const r = await saveCard({ ...parsed, c: code }, { enabled: features().card, ip, ua, site: SITE }, store, stripeClient(env("STRIPE_SECRET_KEY") ?? ""));
    return json(r.body, r.http);
  }

  // ---- POST /claim/inquiry {kind, address?, email, company?, properties?, bills?, source_path?} (SPEC-07) ------------
  // The public site's forms. No claim code, no lookup, nothing returned about any property: the row waits for a human
  // to answer by e-mail. 30 per IP per hour, counted like the other page events.
  if (req.method === "POST" && path.endsWith("/inquiry")) {
    const body = await req.json().catch(() => null);
    const parsed = parseInquiry(body);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
    if (await rateLimited(sb, ip, ["inquiry"], 30)) return json({ ok: false, error: "rate_limited" }, 429);
    const { data: row, error } = await sb.from("inquiries").insert({ ...parsed.row, ip, ua }).select("id").single();
    if (error || !row) return json({ ok: false, error: "server_error" }, 500);
    inBackground(sb.from("events").insert({ claim_code: null, kind: "inquiry", detail: { ip, ua, source: "page", kind: parsed.row.kind, inquiry_id: row.id, source_path: parsed.row.source_path } }));
    inBackground(sb.from("audit_log").insert({ actor: "claim-api", action: "inquiry_received", entity: "inquiries", entity_id: row.id, detail: { kind: parsed.row.kind, has_address: !!parsed.row.address, company: parsed.row.company } }));
    return json({ ok: true, inquiry_id: row.id });
  }

  // ---- POST /claim (multipart) -------------------------------------------------------------------------------------
  if (req.method === "POST") {
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ ok: false, errors: ["Bad form"] }, 400); }
    const get = (k: string) => String(form.get(k) ?? "").trim();
    const code = normCode(get("c"));
    if (!code) return json({ ok: false, error: "not_found" }, 404);
    const found = await loadLead(sb, code);
    if (!found) return json({ ok: false, error: "not_found" }, 404);
    const { lead } = found;
    const front = form.get("dl_front"), back = form.get("dl_back");
    const typed = parseTypedFields(get);

    // ---- follow-ups on an existing claim: re-upload (SPEC-02) or typed confirmation (SPEC-06 §4) -----------------
    if (!OPEN.includes(lead.status)) {
      const claim = lead.status === "claimed" ? await latestClaimForLead(sb, lead.id) : null;
      if (!claim) return json({ ok: false, error: "closed", status: lead.status }, 409);
      const mode = followUpMode({ status: claim.status, findings: claim.findings as Finding[], hasFront: front instanceof File && front.size > 0, hasTyped: !!typed });
      if ("error" in mode) return json({ ok: false, error: "conflict", status: claim.status, reason: mode.reason }, 409);

      if (mode.mode === "reupload") {
        if (!validFile(front)) return json({ ok: false, errors: ["License photo must be a JPEG/PNG/WebP/PDF under 15 MB."] }, 400);
        const suffix = `-${Date.now()}`;
        const frontPath = await storeUpload(sb, claim.id, "dl_front", front, suffix);
        if (!frontPath) return json({ ok: false, errors: ["Upload failed. Please try again."] }, 500);
        if (validFile(back)) await storeUpload(sb, claim.id, "dl_back", back, suffix);
        await sb.from("claims").update({ status: "processing" }).eq("id", claim.id).eq("status", "needs_dl_update");
        await sb.from("events").insert({ claim_code: code, kind: "dl_fix_uploaded", detail: { ip, ua, claim_id: claim.id, source: "api" } });
        await sb.from("audit_log").insert({ actor: "claim-api", action: "dl_reuploaded", entity: "claims", entity_id: claim.id, detail: { code, storage_path: frontPath } });
        kickProcessClaim({ claim_id: claim.id });
        return json({ ok: true, claim_id: claim.id, status: "processing", mode: "reupload" });
      }

      // typed confirmation: the extraction row keeps the model output; a typed_id row holds what the customer confirmed
      const { data: frontDoc } = await sb.from("documents").select("extracted").eq("claim_id", claim.id).eq("kind", "dl_front").order("created_at", { ascending: false }).limit(1).maybeSingle();
      const extracted = typedExtracted(typed!, (frontDoc?.extracted ?? undefined) as Partial<Extracted> | undefined);
      await sb.from("documents").insert({ claim_id: claim.id, kind: "typed_id", storage_path: null, extracted });
      await sb.from("claims").update({ status: "processing" }).eq("id", claim.id).eq("status", "needs_review");
      await sb.from("audit_log").insert({ actor: "claim-api", action: "typed_confirmation", entity: "claims", entity_id: claim.id, detail: { code, fields: Object.keys(typed!) } });
      kickProcessClaim({ claim_id: claim.id, typed_confirmation: true });
      return json({ ok: true, claim_id: claim.id, status: "processing", mode: "typed_confirm" });
    }

    // ---- new claim ------------------------------------------------------------------------------------------------
    const fullName = get("full_name"), email = get("email"), phone = get("phone"), sig = get("signature_name");
    const ownedJan1 = get("owned_jan1"), primary = get("primary"), otherHs = get("other_hs"), movedIn = get("moved_in");
    const household = ["single", "married", "other"].includes(get("household")) ? get("household") : "single";
    const prevHs = get("prev_homestead") === "yes", prevAddr = get("prev_homestead_address");
    const consents = ["agree_terms", "agree_esign", "agree_free"].every((k) => form.get(k) != null);

    const errors: string[] = [];
    if (!fullName || !email || !sig) errors.push("Name, email, and typed signature are required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("Please enter a valid email address.");
    if (!consents) errors.push("Please check all three agreement boxes.");
    if (!(front instanceof File) || front.size === 0) errors.push("Please add a photo of the front of your license.");
    else if (!validFile(front)) errors.push("License photo must be a JPEG/PNG/WebP/PDF under 15 MB.");
    if (sig && fullName && sig.toLowerCase().replace(/\s+/g, " ") !== fullName.toLowerCase().replace(/\s+/g, " ")) {
      errors.push("Your typed signature must match your full name exactly.");
    }
    if (errors.length) return json({ ok: false, errors }, 400);

    // Eligibility answers that block before any extraction run: structured findings from the rule table (ADR 0013/0016).
    const findings: Finding[] = [];
    if (primary === "no") findings.push(makeFinding("not_primary"));
    if (otherHs === "yes") findings.push(makeFinding("other_homestead"));
    const status = findings.length ? "needs_review" : "submitted";
    const reason = reasonText(findings);   // legacy display string; claims.findings is the source of truth
    let occupiedSince: string | null = null;
    if (ownedJan1 === "no" && /^\d{4}-\d{2}$/.test(movedIn)) occupiedSince = movedIn + "-01";

    // The account: look the e-mail up (citext = case-insensitive); attach, or create it from this claim.
    let account = (await sb.from("customers").select("id").eq("email", email).maybeSingle()).data;
    let created = false;
    if (!account) {
      const ins = await sb.from("customers").insert({ email, full_name: fullName, phone: phone || null }).select("id").single();
      if (ins.error) account = (await sb.from("customers").select("id").eq("email", email).maybeSingle()).data; // lost a race: someone inserted it
      else { account = ins.data; created = true; }
    } else {
      await sb.from("customers").update({ full_name: fullName, phone: phone || null }).eq("id", account.id); // latest values as typed
    }
    if (!account) return json({ ok: false, errors: ["Something went wrong saving your claim. Please try again."] }, 500);

    const { data: cust, error: cErr } = await sb.from("claims").insert({
      lead_id: lead.id, customer_id: account.id, service_type: "homestead_refund", full_name: fullName, email, phone: phone || null,
      occupied_since: occupiedSince, owns_other_homestead: otherHs === "yes",
      household, prev_homestead: prevHs, prev_homestead_address: prevHs ? prevAddr || null : null,
      agreement_version: "v0.1", agreement_signed_at: new Date().toISOString(),
      signature_name: sig, signature_ip: ip, signature_ua: ua, status, status_reason: reason, findings,
    }).select("id").single();
    if (cErr || !cust) return json({ ok: false, errors: ["Something went wrong saving your claim. Please try again."] }, 500);
    if (created) await sb.from("customers").update({ created_from_claim_id: cust.id }).eq("id", account.id);

    const frontPath = await storeUpload(sb, cust.id, "dl_front", front as File, "");
    if (!frontPath) return json({ ok: false, errors: ["Upload failed. Please try again."] }, 500);
    if (validFile(back)) await storeUpload(sb, cust.id, "dl_back", back, "");
    // The typed pre-check (SPEC-06 §3), if the page sent it along: a typed_id document with no file.
    if (typed) await sb.from("documents").insert({ claim_id: cust.id, kind: "typed_id", storage_path: null, extracted: typedExtracted(typed) });

    await sb.from("leads").update({ status: "claimed" }).eq("id", lead.id);
    await sb.from("events").insert({ claim_code: code, kind: "claim_submitted", detail: { ip, ua, claim_id: cust.id, customer_id: account.id, status, typed_precheck: !!typed } });
    await sb.from("audit_log").insert({ actor: "claim-api", action: "claim_submitted", entity: "claims", entity_id: cust.id, detail: { code, status, reason, findings: findings.map((f) => f.code), customer_id: account.id, account_created: created } });

    kickProcessClaim({ claim_id: cust.id });
    return json({ ok: true, first_name: fullName.split(" ")[0], claim_id: cust.id, customer_id: account.id, status });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
});
