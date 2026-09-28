// selftest: end-to-end regression that runs inside Supabase's network (Claude's sandbox can't reach supabase.co directly).
// GET /selftest?key=<OPS_PASSWORD>&scenario=match|mismatch|mismatch_then_fix
//   -> resets the synthetic lead, generates a synthetic Texas-style ID as a PDF (pdf-lib, no binary transport needed),
//      submits it through the REAL claim endpoint, waits for process-claim, and returns the resulting rows.
//   match             ID address == situs                      -> ready_to_submit
//   mismatch          situs moved to Brodie Ln, ID says Duval  -> needs_dl_update
//   mismatch_then_fix mismatch, then a matching ID re-uploaded through the SPEC-02 path -> ready_to_submit with a second
//                     packet; a further re-upload on the now-ready claim must be refused with 409.
//   card              SPEC-03: flag-independent — GET /claim must carry `features {card, stripe_publishable_key}` with a
//                     consistent shape, and POST /claim/card must answer 409 card_disabled (flag off) or 404 for a claim id
//                     that is not this lead's (flag on). A real SetupIntent needs a browser (eval/web_smoke.py scenario F).
// Every other scenario also probes GET /claim/precheck (SPEC-06 §3) with the situs (expect match) and another address (expect
// mismatch) and reports the round-trip time.
// Only ever touches the synthetic lead CB-TEST-0001 / property 999000001. The photo-quality vision eval runs separately
// from the repo (eval/run_extraction_eval.py) against 30 synthetic JPEG photos.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { serviceClient } from "./db.ts";

const TEST_CODE = "CB-TEST-0001";
const TEST_PROP = 999000001;
const DUVAL = { situs_num: "3675", situs_street: "DUVAL ST", situs_zip: "78721", situs_full: "3675 DUVAL ST, AUSTIN, TX 78721", line1: "3675 DUVAL ST", line2: "AUSTIN, TX 78721" };
const BRODIE = { situs_num: "1200", situs_street: "BRODIE LN", situs_zip: "78745", situs_full: "1200 BRODIE LN, AUSTIN, TX 78745", line1: "1200 BRODIE LN", line2: "AUSTIN, TX 78745" };

async function opsKey(sb: ReturnType<typeof serviceClient>): Promise<string> {
  const env = Deno.env.get("OPS_PASSWORD"); if (env) return env;
  const { data } = await sb.from("app_settings").select("value").eq("key", "OPS_PASSWORD").maybeSingle();
  return data?.value ?? "";
}

/** A generic ID-card layout as a one-page PDF: the same fields the JPEG eval set carries. */
async function syntheticIdPdf(addr: { line1: string; line2: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([340, 214]); // ID-1 card proportions in points
  const f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 0, y: 184, width: 340, height: 30, color: rgb(0.16, 0.36, 0.24) });
  page.drawText("TEXAS  DRIVER LICENSE", { x: 12, y: 194, size: 13, font: fb, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 12, y: 60, width: 80, height: 110, color: rgb(0.78, 0.8, 0.84), borderColor: rgb(0.5, 0.5, 0.55), borderWidth: 1 });
  const rows: Array<[string, string, boolean]> = [
    ["DL", "17912728", false], ["EXP", "09/03/2031", false], ["DOB", "07/11/1963", false],
    ["1", "GARCIA", true], ["2", "RICHARD L", true], ["8", addr.line1, false], ["", addr.line2, false],
  ];
  let y = 165;
  for (const [k, v, bold] of rows) {
    page.drawText(k, { x: 104, y, size: 7, font: f, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(v, { x: 122, y: y - 1, size: bold ? 12 : 10, font: bold ? fb : f, color: rgb(0.1, 0.1, 0.1) });
    y -= 15;
  }
  page.drawText("SEX M   HGT 5'-11\"   EYES BRO", { x: 104, y: 42, size: 7, font: f, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("ISS 02/04/2023", { x: 12, y: 44, size: 7, font: f, color: rgb(0.3, 0.3, 0.3) });
  page.drawText("Garcia Richard", { x: 12, y: 18, size: 9, font: f, color: rgb(0.15, 0.15, 0.4) });
  return await doc.save();
}

function pdfFile(bytes: Uint8Array): File {
  return new File([bytes.slice().buffer as ArrayBuffer], "front.pdf", { type: "application/pdf" });
}

Deno.serve(async (req: Request) => {
  const sb = serviceClient();
  const url = new URL(req.url);
  const want = await opsKey(sb);
  if (!want || url.searchParams.get("key") !== want) return new Response("forbidden", { status: 403 });
  const scenario = url.searchParams.get("scenario") ?? "match";
  if (!["match", "mismatch", "mismatch_then_fix", "card"].includes(scenario)) return Response.json({ error: "unknown scenario" }, { status: 400 });
  const base = Deno.env.get("SUPABASE_URL")!;
  const t0 = Date.now();
  const headers = { "x-forwarded-for": "203.0.113.7", "user-agent": "selftest" };

  if (scenario === "card") {
    const rg = await fetch(`${base}/functions/v1/claim?c=${TEST_CODE}`, { headers });
    const jg = await rg.json().catch(() => ({})) as { features?: { card?: unknown; stripe_publishable_key?: unknown } };
    const f = jg.features ?? {};
    const shapeOk = typeof f.card === "boolean" && (f.stripe_publishable_key === null || typeof f.stripe_publishable_key === "string") &&
      (f.card ? /^pk_(test|live)_/.test(String(f.stripe_publishable_key)) : f.stripe_publishable_key === null);
    const rc = await fetch(`${base}/functions/v1/claim/card`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ c: TEST_CODE, claim: "00000000-0000-0000-0000-000000000000", confirmation_token: "ctoken_selftest" }) });
    const jc = await rc.json().catch(() => ({})) as { error?: string };
    const guardOk = f.card ? rc.status === 404 && jc.error === "not_found" : rc.status === 409 && jc.error === "card_disabled";
    return Response.json({ scenario, pass: shapeOk && guardOk, elapsed_ms: Date.now() - t0, features: { card: f.card ?? null, key_prefix: typeof f.stripe_publishable_key === "string" ? f.stripe_publishable_key.slice(0, 8) : null },
      card_route: { http: rc.status, error: jc.error ?? null }, shape_ok: shapeOk, guard_ok: guardOk }, { headers: { "cache-control": "no-store" } });
  }

  // 1. reset the synthetic lead + property for the scenario
  const { data: lead } = await sb.from("leads").select("id").eq("claim_code", TEST_CODE).single();
  if (!lead) return Response.json({ error: "test lead missing" }, { status: 500 });
  const { data: custs } = await sb.from("claims").select("id").eq("lead_id", lead.id);
  for (const c of custs ?? []) {
    const { data: fil } = await sb.from("filings").select("id").eq("claim_id", c.id);
    if (fil?.length) { await sb.from("refunds").delete().in("filing_id", fil.map((x) => x.id)); await sb.from("record_checks").delete().in("filing_id", fil.map((x) => x.id)); }
    await sb.from("messages").delete().eq("claim_id", c.id);
    await sb.from("filings").delete().eq("claim_id", c.id);
    await sb.from("documents").delete().eq("claim_id", c.id);
    const { data: objs } = await sb.storage.from("ids").list(c.id);
    if (objs?.length) await sb.storage.from("ids").remove(objs.map((o) => `${c.id}/${o.name}`));
  }
  await sb.from("customers").update({ created_from_claim_id: null }).in("created_from_claim_id", (custs ?? []).map((c) => c.id));
  await sb.from("claims").delete().eq("lead_id", lead.id);   // the synthetic account (selftest@example.com) is kept and re-attached
  await sb.from("leads").update({ status: "new" }).eq("id", lead.id);
  const situs = scenario === "match" ? DUVAL : BRODIE;
  await sb.from("properties").update({ situs_num: situs.situs_num, situs_street: situs.situs_street, situs_zip: situs.situs_zip, situs_full: situs.situs_full }).eq("prop_id", TEST_PROP);

  // 1b. the typed pre-check (SPEC-06 §3): the situs must match, another address must not; both should be fast
  const probe = async (address: string, zip: string) => {
    const s = Date.now();
    const r = await fetch(`${base}/functions/v1/claim/precheck?c=${TEST_CODE}&address=${encodeURIComponent(address)}&zip=${zip}`, { headers });
    const j = await r.json().catch(() => ({})) as { match?: boolean };
    return { match: j.match ?? null, http: r.status, ms: Date.now() - s };
  };
  const preMatch = await probe(situs.line1, situs.situs_zip), preMiss = await probe("900 CONGRESS AVE", "78701");
  const precheckOk = preMatch.match === true && preMiss.match === false;

  // 2. submit through the real claim endpoint (the ID always says Duval; the property decides the outcome)
  const fd = new FormData();
  fd.set("c", TEST_CODE); fd.set("owned_jan1", "yes"); fd.set("primary", "yes"); fd.set("other_hs", "no");
  fd.set("full_name", "Richard L Garcia"); fd.set("email", "selftest@example.com"); fd.set("phone", ""); fd.set("household", "single"); fd.set("prev_homestead", "no");
  fd.set("agree_terms", "on"); fd.set("agree_esign", "on"); fd.set("agree_free", "on"); fd.set("signature_name", "Richard L Garcia");
  fd.set("dl_front", pdfFile(await syntheticIdPdf(DUVAL)));
  const res = await fetch(`${base}/functions/v1/claim`, { method: "POST", body: fd, headers });
  const claimJson = await res.json().catch(() => ({ ok: false })) as { ok?: boolean; errors?: string[]; claim_id?: string };

  // 3. wait for process-claim (kicked in the background by the claim API) — poll up to ~45 s
  const waitSettled = async () => {
    let c: Record<string, unknown> | null = null;
    for (let i = 0; i < 45; i++) {
      const { data } = await sb.from("claims").select("*").eq("lead_id", lead.id).maybeSingle();
      c = data;
      if (c && !["submitted", "processing"].includes(String(c.status))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return c;
  };
  let cust = await waitSettled();
  const firstStatus = cust?.status as string | undefined;

  // 4. SPEC-02: re-upload a license that now matches, through the same POST /claim; then prove a second re-upload is refused
  let fix: Record<string, unknown> | null = null;
  if (scenario === "mismatch_then_fix") {
    const fd2 = new FormData(); fd2.set("c", TEST_CODE); fd2.set("dl_front", pdfFile(await syntheticIdPdf(BRODIE)));
    const r2 = await fetch(`${base}/functions/v1/claim`, { method: "POST", body: fd2, headers });
    const j2 = await r2.json().catch(() => ({})) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 1500));   // the API sets `processing` synchronously before kicking process-claim
    cust = await waitSettled();
    const fd3 = new FormData(); fd3.set("c", TEST_CODE); fd3.set("dl_front", pdfFile(await syntheticIdPdf(BRODIE)));
    const r3 = await fetch(`${base}/functions/v1/claim`, { method: "POST", body: fd3, headers });
    fix = { reupload_http: r2.status, reupload_response: j2, status_after_fix: cust?.status ?? null, conflict_http: r3.status };
  }

  const cid = cust?.id as string | undefined;
  const { data: docs } = cid ? await sb.from("documents").select("kind, mime, storage_path, extracted, validation, extraction_cost_usd, created_at").eq("claim_id", cid).order("created_at", { ascending: false }) : { data: null };
  const { data: filings } = cid ? await sb.from("filings").select("packet_path, packet_sha256, form_version, generated_at").eq("claim_id", cid).order("generated_at") : { data: null };
  const { data: msgs } = cid ? await sb.from("messages").select("intent, subject").eq("claim_id", cid) : { data: null };
  const { data: account } = cust?.customer_id ? await sb.from("customers").select("id, email, created_from_claim_id").eq("id", String(cust.customer_id)).maybeSingle() : { data: null };
  const { count: claimsOnAccount } = cust?.customer_id ? await sb.from("claims").select("id", { count: "exact", head: true }).eq("customer_id", String(cust.customer_id)) : { count: null };
  const { data: audit } = cid ? await sb.from("audit_log").select("action, detail").eq("entity_id", cid).order("id", { ascending: false }).limit(5) : { data: null };

  // 5. the poll endpoint the page uses (SPEC-06 §2) must agree with the row
  let poll: Record<string, unknown> | null = null;
  if (cid) {
    const rp = await fetch(`${base}/functions/v1/claim?c=${TEST_CODE}&claim=${cid}`, { headers });
    const jp = await rp.json().catch(() => ({})) as Record<string, unknown>;
    poll = { http: rp.status, status: jp.status ?? null, findings: Array.isArray(jp.findings) ? (jp.findings as Array<{ code: string }>).map((f) => f.code) : null, has_packet_url: typeof jp.packet_url === "string" };
  }

  const expected = scenario === "mismatch" ? "needs_dl_update" : "ready_to_submit";
  let pass = cust?.status === expected && precheckOk && poll?.status === cust?.status;
  if (scenario === "mismatch_then_fix") {
    pass = pass && firstStatus === "needs_dl_update" && fix?.conflict_http === 409 && (filings?.length ?? 0) >= 2 &&
      (docs ?? []).filter((d) => d.kind === "dl_front").length === 2 && poll?.has_packet_url === true;
  }
  if (scenario === "match") pass = pass && poll?.has_packet_url === true;

  return Response.json({
    scenario, expected_status: expected, pass,
    claim_http: res.status, claim_api_ok: claimJson.ok === true, claim_errors: claimJson.errors ?? null, elapsed_ms: Date.now() - t0,
    first_status: firstStatus ?? null, fix, precheck: { ok: precheckOk, match: preMatch, mismatch: preMiss }, poll,
    claim: cust && { id: cid, status: cust.status, status_reason: cust.status_reason, signature_ip: cust.signature_ip, customer_id: cust.customer_id,
                     findings: cust.findings, findings_structured: Array.isArray(cust.findings) && (cust.findings as unknown[]).every((f) => typeof f === "object" && f !== null && "code" in (f as object)) },
    account: account && { ...account, claims_on_account: claimsOnAccount },
    documents: docs, filings, messages: msgs, audit,
  }, { headers: { "cache-control": "no-store" } });
});
