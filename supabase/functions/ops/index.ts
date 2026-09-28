// ops API (JSON) — the operator console's only backend (SPEC-09 D1, ADR 0020). Password-gated via the x-ops-key
// header or ?key=; 20 failed keys per IP per hour → 429 (counted as events of kind ops_auth_fail).
//   GET  /ops?status=&limit=   -> {ok, kpis, funnel, claims, inquiries, system, features, mail}   (mail: SPEC-11 batches)
//   POST /ops {action, …}      -> approve | discard | send {message_id} · mark_filed {claim_id, channel} · reprocess {claim_id}
//                                 · withdraw {claim_id} · inquiry_handled {inquiry_id, notes} · new_claim {prop_id | address, create}
//                                 · run_selftest {scenario} · system_status {key, value} (workflows report their last run)
// Every mutating action writes audit_log (actor 'ops'); the status guards are in logic.ts (mirror of cleanbill/agent/store.py).
// `send` (SPEC-10, ADR 0022) is the ONE place that e-mails a customer: an operator's click on an approved message, through
// Resend, only with RESEND_ENABLED=true. Nothing here files with TCAD or charges (shadow mode; B-13).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { clientIp, serviceClient } from "./db.ts";
import { BRAND, SUPPORT_EMAIL } from "../_shared/db.ts";
import { renderEmail } from "../_shared/email.ts";
import { CLAIM_STATUSES, claimLink, filedDraft, FUNNEL_KINDS, funnelSteps, guardAction, maskSelftest, parseChannel, parseLimit, SELFTEST_SCENARIOS, addressKey, scoreMatch, attachmentPlan, featureFlags, guardSend, MAX_ATTACHMENT_BYTES, resendPayload } from "./logic.ts";

type SB = ReturnType<typeof serviceClient>;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-ops-key", "cache-control": "no-store" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const SITE_BASE = Deno.env.get("BRAND_URL") ?? "https://cleanbillco.com";
const AUTH_FAILS_PER_HOUR = 20;
const RESEND_BASE_URL = (Deno.env.get("RESEND_BASE_URL") ?? "https://api.resend.com").replace(/\/$/, "");
const RESEND_TIMEOUT_MS = 20_000;
const features = () => featureFlags((k) => Deno.env.get(k));

async function opsKey(sb: SB): Promise<string> {
  const env = Deno.env.get("OPS_PASSWORD"); if (env) return env;
  const { data } = await sb.from("app_settings").select("value").eq("key", "OPS_PASSWORD").maybeSingle();
  return data?.value ?? "";
}

function inBackground(p: PromiseLike<unknown>) {
  const promise = Promise.resolve(p).catch((e) => console.error("background task failed", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(promise);
}

async function audit(sb: SB, action: string, entity: string, entityId: string, detail: Record<string, unknown> = {}) {
  await sb.from("audit_log").insert({ actor: "ops", action, entity, entity_id: entityId, detail });
}

async function count(sb: SB, table: string, col: string, val: string): Promise<number> {
  const { count } = await sb.from(table).select("id", { count: "exact", head: true }).eq(col, val);
  return count ?? 0;
}

// ---- POST actions ---------------------------------------------------------------------------------------------------
async function loadClaim(sb: SB, id: string) {
  const { data } = await sb.from("claims").select("id, status, lead_id, leads(claim_code, prop_id, properties(situs_full))").eq("id", id).maybeSingle();
  return data as { id: string; status: string; lead_id: string; leads?: { claim_code: string; prop_id: number; properties?: { situs_full: string } } } | null;
}

async function markFiled(sb: SB, claimId: string, channelRaw: unknown): Promise<Response> {
  const c = await loadClaim(sb, claimId);
  if (!c) return json({ ok: false, error: "not_found" }, 404);
  const g = guardAction("mark_filed", c.status);
  if (!g.ok) return json({ ok: false, error: g.error, status: c.status }, g.status);
  const { data: fil } = await sb.from("filings").select("id, submitted_at").eq("claim_id", c.id).order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (!fil) return json({ ok: false, error: "no_filing" }, 409);
  const channel = parseChannel(channelRaw);
  const now = new Date();
  await sb.from("filings").update({ submitted_at: now.toISOString(), channel }).eq("id", fil.id);
  await sb.from("claims").update({ status: "filed", status_reason: `marked filed by ops via ${channel}`, updated_at: now.toISOString() }).eq("id", c.id);
  await sb.from("leads").update({ status: "filed", updated_at: now.toISOString() }).eq("id", c.lead_id);
  const draft = filedDraft(c.leads?.properties?.situs_full ?? "your property", now, channel);
  const { data: msg } = await sb.from("messages").insert({ claim_id: c.id, direction: "outbound", channel: "email", subject: draft.subject, body: draft.body, intent: draft.intent, agent_draft: true }).select("id").single();
  await audit(sb, "mark_filed", "claims", c.id, { filing_id: fil.id, channel, message_id: msg?.id ?? null, from: c.status });
  return json({ ok: true, status: "filed", filing_id: fil.id, message_id: msg?.id ?? null });
}

/** SPEC-10: e-mail an approved message to the claim's account through Resend. Guards in logic.ts (guardSend); the packet
 *  rides ready_to_submit / filed; `update … where sent_at is null` plus Resend's Idempotency-Key make a double-click send
 *  once. On a provider error nothing changes but the audit row. */
async function sendMessage(sb: SB, messageId: string): Promise<Response> {
  const enabled = features().resend;
  const { data: m } = await sb.from("messages").select("id, claim_id, direction, channel, agent_draft, sent_at, intent, subject, body").eq("id", messageId).maybeSingle();
  let email: string | null = null, code: string | null = null, packetPath: string | null = null;
  if (m) {
    const { data: c } = await sb.from("claims").select("id, email, customers(email), leads(claim_code)").eq("id", m.claim_id).maybeSingle();
    const row = c as { email: string | null; customers?: { email: string | null } | null; leads?: { claim_code: string } | null } | null;
    email = row?.customers?.email ?? row?.email ?? null;   // the account's address (v2); the claim's own only for a pre-v2 row without an account
    code = row?.leads?.claim_code ?? null;
    const { data: fil } = await sb.from("filings").select("packet_path").eq("claim_id", m.claim_id).order("generated_at", { ascending: false }).limit(1).maybeSingle();
    packetPath = fil?.packet_path ?? null;
  }
  const g = guardSend(m, email, enabled);
  if (!g.ok) return json({ ok: false, error: g.error }, g.status);
  const msg = m!;
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { await audit(sb, "message_send_failed", "messages", msg.id, { status: 0, error: "RESEND_API_KEY not set" }); return json({ ok: false, error: "provider_error", message: "RESEND_API_KEY is not set" }, 503); }

  const { html, text } = renderEmail(msg.subject!, msg.body!);   // personalisation is already in the approved body; no substitution here
  let attachment: { filename: string; content: string } | null = null;
  const plan = attachmentPlan(msg.intent, packetPath, code);
  if (plan) {
    const { data: blob, error } = await sb.storage.from("packets").download(plan.path);
    if (error || !blob) { await audit(sb, "message_send_failed", "messages", msg.id, { status: 0, error: `packet download: ${error?.message ?? "empty"}` }); return json({ ok: false, error: "packet_unavailable", path: plan.path }, 502); }
    if (blob.size > MAX_ATTACHMENT_BYTES) return json({ ok: false, error: "packet_too_large", bytes: blob.size, max: MAX_ATTACHMENT_BYTES }, 409);
    attachment = { filename: plan.filename, content: encodeBase64(await blob.arrayBuffer()) };
  }
  const payload = resendPayload({ brand: BRAND, supportEmail: SUPPORT_EMAIL, to: email!, subject: msg.subject!, html, text, attachment, intent: msg.intent, claimCode: code, messageId: msg.id });

  let res: Response | null = null, failure = "";
  try {
    res = await fetch(`${RESEND_BASE_URL}/emails`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": `msg-${msg.id}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (e) { failure = String((e as Error)?.message ?? e); }
  const result = res ? await res.json().catch(() => ({})) as Record<string, unknown> : {};
  if (!res || !res.ok || typeof result.id !== "string") {
    const message = failure || String(result.message ?? result.error ?? `http ${res?.status ?? 0}`);
    await audit(sb, "message_send_failed", "messages", msg.id, { status: res?.status ?? 0, error: message.slice(0, 500), attached: !!attachment });
    return json({ ok: false, error: "provider_error", message: message.slice(0, 500) }, 502);
  }
  const now = new Date().toISOString();
  const { data: claimed } = await sb.from("messages").update({ sent_at: now, provider: "resend", provider_message_id: result.id, delivery_status: "sent" }).eq("id", msg.id).is("sent_at", null).select("id");
  if (!claimed?.length) return json({ ok: false, error: "already_sent" }, 409);   // a concurrent click got there first (same Resend id — idempotent)
  await audit(sb, "message_send", "messages", msg.id, { resend_id: result.id, attached: !!attachment, to_domain: email!.split("@")[1] ?? null, intent: msg.intent });
  return json({ ok: true, sent_at: now, provider_message_id: result.id, attached: !!attachment });
}

async function reprocess(sb: SB, claimId: string): Promise<Response> {
  const c = await loadClaim(sb, claimId);
  if (!c) return json({ ok: false, error: "not_found" }, 404);
  const g = guardAction("reprocess", c.status);
  if (!g.ok) return json({ ok: false, error: g.error, status: c.status }, g.status);
  inBackground(fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-claim`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify({ claim_id: c.id }),
  }));
  await audit(sb, "reprocess", "claims", c.id, { from: c.status });
  return json({ ok: true, status: c.status, kicked: true });
}

async function withdraw(sb: SB, claimId: string): Promise<Response> {
  const c = await loadClaim(sb, claimId);
  if (!c) return json({ ok: false, error: "not_found" }, 404);
  const g = guardAction("withdraw", c.status);
  if (!g.ok) return json({ ok: false, error: g.error, status: c.status }, g.status);
  await sb.from("claims").update({ status: "withdrawn", status_reason: "withdrawn by ops", updated_at: new Date().toISOString() }).eq("id", c.id);
  await audit(sb, "withdraw", "claims", c.id, { from: c.status });
  return json({ ok: true, status: "withdrawn" });
}

async function inquiryHandled(sb: SB, inquiryId: string, notes: unknown): Promise<Response> {
  const { data: row } = await sb.from("inquiries").select("id").eq("id", inquiryId).maybeSingle();
  if (!row) return json({ ok: false, error: "not_found" }, 404);
  const n = String(notes ?? "").slice(0, 2000) || null;
  await sb.from("inquiries").update({ handled_at: new Date().toISOString(), notes: n }).eq("id", inquiryId);
  await audit(sb, "inquiry_handled", "inquiries", inquiryId, { notes: n });
  return json({ ok: true });
}

/** Walkthrough claims over the published properties: preview matches (owner, situs, estimate, already-exempt flag, the
 *  lead's code and status), then `create: true` with a prop_id confirms the code and link. A published property always
 *  has a lead (the ETL publishes them together); one without is the Mac CLI's case. */
async function newClaim(sb: SB, body: Record<string, unknown>): Promise<Response> {
  const propId = Number(body.prop_id);
  const address = String(body.address ?? "").trim();
  const sel = "prop_id, situs_full, owner_name, hs_exempt, ov65_exempt, appraised_value, deed_date, leads(id, claim_code, status, tier, refund_years, est_refund_total, est_forward_annual, estimate_unconfirmed)";
  type Row = { prop_id: number; situs_full: string; owner_name: string; hs_exempt: boolean; ov65_exempt: boolean; appraised_value: number | null; deed_date: string | null; leads: Array<{ id: string; claim_code: string; status: string; tier: number; refund_years: number[]; est_refund_total: number; est_forward_annual: number; estimate_unconfirmed: boolean }> | null };
  let rows: Row[] = [];
  if (Number.isFinite(propId) && propId > 0) {
    const { data } = await sb.from("properties").select(sel).eq("prop_id", propId).limit(1);
    rows = (data ?? []) as unknown as Row[];
  } else if (address) {
    const { num, key, words } = addressKey(address);
    if (!key) return json({ ok: false, error: "bad_request", hint: "house number and street, e.g. 3675 Duval St" }, 400);
    let q = sb.from("properties").select(sel).ilike("situs_full", `%${key}%`).limit(60);
    if (num) q = q.ilike("situs_full", `${num} %`);
    const { data } = await q;
    rows = ((data ?? []) as unknown as Row[]).map((r) => ({ r, s: scoreMatch(r.situs_full, words) })).sort((a, b) => b.s - a.s || a.r.situs_full.localeCompare(b.r.situs_full)).slice(0, 8).map((x) => x.r);
  } else return json({ ok: false, error: "bad_request", hint: "prop_id or address" }, 400);
  const matches = rows.map((r) => {
    const lead = r.leads?.[0] ?? null;
    return {
      prop_id: r.prop_id, situs_full: r.situs_full, owner_name: r.owner_name, hs_exempt: !!r.hs_exempt, ov65_exempt: !!r.ov65_exempt,
      appraised_value: r.appraised_value, deed_date: r.deed_date,
      lead: lead ? { claim_code: lead.claim_code, status: lead.status, tier: lead.tier, refund_years: lead.refund_years, est_refund_total: lead.est_refund_total, est_forward_annual: lead.est_forward_annual, estimate_unconfirmed: lead.estimate_unconfirmed, link: claimLink(SITE_BASE, lead.claim_code) } : null,
    };
  });
  if (!body.create) return json({ ok: true, matches });
  if (!(Number.isFinite(propId) && propId > 0)) return json({ ok: false, error: "bad_request", hint: "create needs prop_id (pick one match)" }, 400);
  const m = matches[0];
  if (!m) return json({ ok: false, error: "not_found" }, 404);
  if (!m.lead) return json({ ok: false, error: "no_lead_for_property", hint: "not in the published lead list — use python -m cleanbill.ops.new_claim on the Mac" }, 409);
  if (["suppressed", "closed"].includes(m.lead.status)) return json({ ok: false, error: `lead_${m.lead.status}`, status: m.lead.status }, 409);
  await audit(sb, "new_claim", "leads", m.lead.claim_code, { prop_id: m.prop_id, hs_exempt: m.hs_exempt, lead_status: m.lead.status });
  return json({ ok: true, claim_code: m.lead.claim_code, link: m.lead.link, status: m.lead.status, hs_exempt: m.hs_exempt, match: m });
}

async function runSelftest(sb: SB, want: string, scenarioRaw: unknown): Promise<Response> {
  const scenario = String(scenarioRaw ?? "match");
  if (!SELFTEST_SCENARIOS.includes(scenario)) return json({ ok: false, error: "bad_request", hint: SELFTEST_SCENARIOS.join("|") }, 400);
  const t0 = Date.now();
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/selftest?key=${encodeURIComponent(want)}&scenario=${scenario}`, { signal: AbortSignal.timeout(120_000) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }));
  const result = await r.json().catch(() => ({ error: `http ${r.status}` }));
  const pass = r.ok && (result as { pass?: boolean }).pass === true;
  await audit(sb, "run_selftest", "selftest", scenario, { pass, ms: Date.now() - t0, http: r.status });
  return json({ ok: true, scenario, pass, ms: Date.now() - t0, result: maskSelftest(result) });
}

async function systemStatus(sb: SB, keyRaw: unknown, value: unknown): Promise<Response> {
  const key = String(keyRaw ?? "").trim();
  if (!/^[a-z_]{1,40}$/.test(key) || typeof value !== "object" || value === null) return json({ ok: false, error: "bad_request", hint: "key [a-z_], value object" }, 400);
  const now = new Date().toISOString();
  await sb.from("system_status").upsert({ key, value, updated_at: now }, { onConflict: "key" });
  await audit(sb, "system_status", "system_status", key, { keys: Object.keys(value as Record<string, unknown>) });
  return json({ ok: true, key, updated_at: now });
}

async function post(sb: SB, want: string, body: Record<string, unknown>): Promise<Response> {
  const action = String(body.action ?? "");
  switch (action) {
    case "approve": case "discard": {
      const mid = String(body.message_id ?? "");
      if (!mid) return json({ ok: false, error: "bad_request" }, 400);
      if (action === "approve") await sb.from("messages").update({ agent_draft: false, approved_by: "ops", approved_at: new Date().toISOString() }).eq("id", mid);
      if (action === "discard") await sb.from("messages").delete().eq("id", mid);
      await audit(sb, `message_${action}`, "messages", mid);
      return json({ ok: true });
    }
    case "send": return body.message_id ? sendMessage(sb, String(body.message_id)) : json({ ok: false, error: "bad_request" }, 400);
    case "mark_filed": return body.claim_id ? markFiled(sb, String(body.claim_id), body.channel) : json({ ok: false, error: "bad_request" }, 400);
    case "reprocess": return body.claim_id ? reprocess(sb, String(body.claim_id)) : json({ ok: false, error: "bad_request" }, 400);
    case "withdraw": return body.claim_id ? withdraw(sb, String(body.claim_id)) : json({ ok: false, error: "bad_request" }, 400);
    case "inquiry_handled": return body.inquiry_id ? inquiryHandled(sb, String(body.inquiry_id), body.notes) : json({ ok: false, error: "bad_request" }, 400);
    case "new_claim": return newClaim(sb, body);
    case "run_selftest": return runSelftest(sb, want, body.scenario);
    case "system_status": return systemStatus(sb, body.key, body.value);
    default: return json({ ok: false, error: "bad_request", hint: "unknown action" }, 400);
  }
}

// ---- GET -------------------------------------------------------------------------------------------------------------
async function dashboard(sb: SB, url: URL): Promise<Response> {
  const statusFilter = url.searchParams.get("status");
  const limit = parseLimit(url.searchParams.get("limit"));
  const dayMs = 86_400_000;
  const since7 = new Date(Date.now() - 7 * dayMs).toISOString(), since30 = new Date(Date.now() - 30 * dayMs).toISOString();

  // Per-status counts via head queries (a plain select is capped at 1,000 rows by PostgREST); events grouped in SQL.
  const leadCounts: Record<string, number> = {}; let leadsTotal = 0;
  for (const st of ["new", "mailed", "opened", "claimed", "filed", "approved", "refunded", "closed", "suppressed"]) { leadCounts[st] = await count(sb, "leads", "status", st); leadsTotal += leadCounts[st]; }
  const claimCounts: Record<string, number> = {};
  for (const st of CLAIM_STATUSES) claimCounts[st] = await count(sb, "claims", "status", st);
  const [{ data: k7 }, { data: kAll }, { data: byDay }] = await Promise.all([
    sb.rpc("ops_events_by_kind", { since: since7 }), sb.rpc("ops_events_by_kind", {}), sb.rpc("ops_events_by_day", { since: since30 }),
  ]);
  const toMap = (rows: Array<{ kind: string; n: number }> | null) => Object.fromEntries(FUNNEL_KINDS.map((k) => [k, Number((rows ?? []).find((r) => r.kind === k)?.n ?? 0)]));
  const byKindAll = toMap(kAll as Array<{ kind: string; n: number }> | null);

  // SPEC-11: mailed / delivered / returned come from mail_pieces (the record); the lead count stays in funnel as a cross-check.
  const [{ data: mailKpis }, { data: mailBatches }] = await Promise.all([sb.rpc("ops_mail_kpis"), sb.rpc("ops_mail_by_batch")]);
  const mk = ((mailKpis as Array<Record<string, number>> | null)?.[0]) ?? { mailed: 0, delivered: 0, returned: 0, rejected: 0 };
  const kpis = {
    leads_loaded: leadsTotal, mailed: Number(mk.mailed ?? 0), delivered: Number(mk.delivered ?? 0), returned: Number(mk.returned ?? 0),
    page_views: byKindAll.view, opened: leadCounts.opened + leadCounts.claimed + leadCounts.filed, claimed: leadCounts.claimed + leadCounts.filed,
    ready_to_submit: claimCounts.ready_to_submit, needs_dl_update: claimCounts.needs_dl_update, needs_review: claimCounts.needs_review,
    filed: claimCounts.filed, approved: claimCounts.approved, refunded: claimCounts.refunded + claimCounts.paid,
    inquiries_open: 0,
  };
  const funnel = { by_kind_7d: toMap(k7 as Array<{ kind: string; n: number }> | null), by_kind_all: byKindAll, by_day_30d: (byDay ?? []) as Array<{ day: string; kind: string; n: number }>, steps: funnelSteps(kpis), leads_mailed: leadCounts.mailed };
  const mail = { batches: ((mailBatches ?? []) as Array<{ batch: string; n: number; sent_at: string | null; delivered: number; returned: number; rejected: number; proof: boolean }>).map((b) => ({ ...b, n: Number(b.n), delivered: Number(b.delivered), returned: Number(b.returned), rejected: Number(b.rejected) })), rejected: Number(mk.rejected ?? 0) };

  // v2: `claims` is the engagement (joined to its lead, property and account); findings are structured on the claim.
  let q = sb.from("claims").select("*, leads(id, claim_code, est_refund_total, prop_id, letter_variant, mailed_at, properties(situs_full, owner_name)), customers(id, email, card_on_file, card_brand, card_last4)").order("created_at", { ascending: false }).limit(limit);
  if (statusFilter && CLAIM_STATUSES.includes(statusFilter)) q = q.eq("status", statusFilter);
  const { data: custs } = await q;
  const ids = (custs ?? []).map((c) => c.id);
  const leadIds = (custs ?? []).map((c) => c.leads?.id).filter((x): x is string => !!x);
  const [{ data: docs }, { data: filings }, { data: msgs }, { data: pieces }] = ids.length
    ? await Promise.all([
      sb.from("documents").select("claim_id, kind, extracted, validation, extraction_cost_usd").in("claim_id", ids),
      sb.from("filings").select("claim_id, packet_path, generated_at, submitted_at, channel, form_version").in("claim_id", ids),
      sb.from("messages").select("*").in("claim_id", ids).order("created_at", { ascending: false }),
      leadIds.length ? sb.from("mail_pieces").select("lead_id, batch, variant, status, delivered_at, created_at, to_override").in("lead_id", leadIds).eq("to_override", false).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const latestFiling = new Map<string, { claim_id: string; packet_path: string | null; generated_at: string; submitted_at: string | null; channel: string | null; form_version: string | null }>();
  for (const f of (filings ?? [])) { const cur = latestFiling.get(f.claim_id); if (!cur || f.generated_at > cur.generated_at) latestFiling.set(f.claim_id, f); }
  const paths = [...latestFiling.values()].map((f) => f.packet_path).filter((p): p is string => !!p);
  const signed = new Map<string, string>();
  if (paths.length) { const { data: s } = await sb.storage.from("packets").createSignedUrls(paths, 600); for (const x of s ?? []) if (x.path && x.signedUrl) signed.set(x.path, x.signedUrl); }

  const claims = (custs ?? []).map((c) => {
    const lead = c.leads ?? {}; const prop = lead.properties ?? {};
    const d = (docs ?? []).find((x) => x.claim_id === c.id && x.kind === "dl_front");
    const fil = latestFiling.get(c.id);
    const piece = (pieces ?? []).find((p) => p.lead_id === lead.id) ?? null;   // the latest real letter to this lead (SPEC-11): its origin
    const ex = d?.extracted as Record<string, unknown> | null;
    const extracted = ex ? Object.fromEntries(Object.entries(ex).filter(([k]) => k !== "dl_number")) : null;   // never the DL number, masked or not
    return {
      id: c.id, customer_id: c.customer_id, account: c.customers ?? null, status: c.status, status_reason: c.status_reason, full_name: c.full_name, email: c.email, phone: c.phone,
      signed_at: c.agreement_signed_at, created_at: c.created_at, updated_at: c.updated_at,
      claim_code: lead.claim_code, est_refund_total: lead.est_refund_total, prop_id: lead.prop_id, situs_full: prop.situs_full, owner_name: prop.owner_name,
      letter: lead.mailed_at || piece ? { variant: lead.letter_variant ?? piece?.variant ?? null, mailed_at: lead.mailed_at ?? piece?.created_at ?? null, delivered_at: piece?.delivered_at ?? null, status: piece?.status ?? null, batch: piece?.batch ?? null } : null,
      extracted,
      findings: Array.isArray(c.findings) && c.findings.length ? c.findings : ((d?.validation as { findings?: unknown[] } | null)?.findings ?? []),
      extraction_cost_usd: d?.extraction_cost_usd ?? null,
      packet: fil ? { url: fil.packet_path ? signed.get(fil.packet_path) ?? null : null, form_version: fil.form_version, generated_at: fil.generated_at, submitted_at: fil.submitted_at, channel: fil.channel } : null,
      messages: (msgs ?? []).filter((m) => m.claim_id === c.id).map((m) => ({ id: m.id, subject: m.subject, body: m.body, intent: m.intent, agent_draft: m.agent_draft, direction: m.direction, channel: m.channel, approved_at: m.approved_at, sent_at: m.sent_at, created_at: m.created_at, provider_message_id: m.provider_message_id ?? null, delivery_status: m.delivery_status ?? null, delivery_detail: Array.isArray(m.delivery_detail) ? m.delivery_detail : [] })),
    };
  });

  const { data: inquiries } = await sb.from("inquiries").select("id, created_at, kind, address, email, company, properties, bills, source_path, handled_at, notes").order("handled_at", { ascending: true, nullsFirst: true }).order("created_at", { ascending: false }).limit(200);
  kpis.inquiries_open = (inquiries ?? []).filter((i) => !i.handled_at).length;
  const { data: system } = await sb.from("system_status").select("key, value, updated_at").order("key");
  return json({ ok: true, kpis, funnel, claims, inquiries: inquiries ?? [], system: system ?? [], features: features(), mail, generated_at: new Date().toISOString() });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const sb = serviceClient();
  const url = new URL(req.url);
  const want = await opsKey(sb);
  const key = req.headers.get("x-ops-key") ?? url.searchParams.get("key") ?? "";
  if (!want || key !== want) {
    const ip = clientIp(req);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count: fails } = await sb.from("events").select("id", { count: "exact", head: true }).eq("kind", "ops_auth_fail").gte("at", since).eq("detail->>ip", ip);
    inBackground(sb.from("events").insert({ claim_code: null, kind: "ops_auth_fail", detail: { ip, ua: req.headers.get("user-agent") ?? "" } }));
    const limited = (fails ?? 0) >= AUTH_FAILS_PER_HOUR;
    return json({ ok: false, error: limited ? "rate_limited" : "forbidden" }, limited ? 429 : 403);
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    return post(sb, want, body);
  }
  return dashboard(sb, url);
});
