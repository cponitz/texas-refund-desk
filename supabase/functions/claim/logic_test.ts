import { extFor, followUpMode, isPageEvent, parseInquiry, parseTypedFields, precheck, stageIndex, timelineFrom, typedExtracted } from "./logic.ts";
import { makeFinding } from "../_shared/findings.ts";
import type { PropertyRec } from "../_shared/validate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(msg ?? `assertEquals failed: ${A} !== ${B}`); }

const prop: PropertyRec = { prop_id: 1, owner_name: "GARCIA RICHARD L", situs_num: "3675", situs_street: "DUVAL ST", situs_zip: "78721", situs_full: "3675 DUVAL ST, AUSTIN, TX 78721" };

Deno.test("precheck: typed address matches / mismatches the situs (SPEC-06 §3)", () => {
  assertEquals(precheck("3675 duval street", "78721", prop), { match: true, id_address: "3675 duval street, 78721", situs: prop.situs_full });
  assertEquals(precheck("900 Congress Ave", "78701", prop).match, false);
  assertEquals(precheck("3675 DUVAL ST", "78704", prop).match, false);   // zip disagrees
  assertEquals(precheck("", "78721", prop).match, false);                // nothing typed is not a match
  assertEquals(precheck("3675 DUVAL ST", "", prop).match, true);         // zip optional
});

Deno.test("follow-up: re-upload only while needs_dl_update, else 409 (SPEC-02)", () => {
  assertEquals(followUpMode({ status: "needs_dl_update", findings: [], hasFront: true, hasTyped: false }), { mode: "reupload" });
  for (const status of ["submitted", "processing", "ready_to_submit", "needs_review", "filed", "withdrawn"]) {
    const r = followUpMode({ status, findings: [], hasFront: true, hasTyped: false });
    assertEquals("error" in r && r.http, 409, status);
  }
});

Deno.test("follow-up: typed confirmation only for needs_review with not_readable/low_confidence (SPEC-06 §4)", () => {
  const low = [makeFinding("address_match"), makeFinding("low_confidence", { confidence: { name: 0.2 } })];
  assertEquals(followUpMode({ status: "needs_review", findings: low, hasFront: false, hasTyped: true }), { mode: "typed_confirm" });
  assertEquals(followUpMode({ status: "needs_review", findings: [makeFinding("not_readable")], hasFront: false, hasTyped: true }), { mode: "typed_confirm" });
  const nm = [makeFinding("name_mismatch", { id: "MARIA LOPEZ", owner: "GARCIA RICHARD L" })];
  assertEquals("error" in followUpMode({ status: "needs_review", findings: nm, hasFront: false, hasTyped: true }), true);
  assertEquals("error" in followUpMode({ status: "needs_dl_update", findings: low, hasFront: false, hasTyped: true }), true);
  assertEquals("error" in followUpMode({ status: "ready_to_submit", findings: [], hasFront: false, hasTyped: false }), true);
});

Deno.test("typed fields: parsed from the form, typed_name split, dob/zip sanitised", () => {
  const form: Record<string, string> = { typed_name: "Richard L Garcia", typed_address: "3675 Duval St", typed_zip: "78721-1234", typed_dob: "07/11/1963" };
  const t = parseTypedFields((k) => form[k] ?? "");
  assertEquals(t, { address_line1: "3675 Duval St", zip: "78721", last_name: "Garcia", first_name: "Richard L" });   // MM/DD dob dropped, zip+4 trimmed
  assertEquals(parseTypedFields(() => ""), null);
  const ex = typedExtracted(t!);
  assertEquals([ex.readable, ex.source, ex.issuing_state, ex.confidence.name, ex.confidence.address, ex.confidence.dob], [true, "typed", "TX", 1, 1, 0]);
  const merged = typedExtracted({ address_line1: "3675 DUVAL ST" }, { first_name: "RICHARD", last_name: "GARCIA", dob: "1963-07-11", confidence: { name: 0.9, dob: 0.9, address: 0.2, dl_number: 0.9, expiry: 0.9 } });
  assertEquals([merged.first_name, merged.dob, merged.confidence.name, merged.confidence.address], ["RICHARD", "1963-07-11", 0.9, 1]);
});

Deno.test("page events allowlist and file extensions", () => {
  assertEquals(["validation_shown", "dl_fix_started", "dl_fix_uploaded", "typed_precheck", "card_skipped", "packet_viewed"].every(isPageEvent), true);
  assertEquals(isPageEvent("card_saved"), false);   // the server writes it after a confirmed SetupIntent (SPEC-03)
  assertEquals(isPageEvent("view"), false);
  assertEquals(isPageEvent("claim_submitted"), false);
  assertEquals([extFor("image/jpeg"), extFor("image/png"), extFor("application/pdf"), extFor("image/heic")], ["jpg", "png", "pdf", "heic"]);
});

Deno.test("inquiry: homeowner forms need address + e-mail, business needs company + e-mail; bills are an allowlist (SPEC-07)", () => {
  const ok = parseInquiry({ kind: "address", address: " 3675 Duval St, Austin 78721 ", email: "a@b.co", source_path: "/" });
  assertEquals(ok, { ok: true, row: { kind: "address", address: "3675 Duval St, Austin 78721", email: "a@b.co", company: null, properties: null, bills: [], source_path: "/" } });
  assertEquals(parseInquiry({ kind: "address", email: "a@b.co" }), { ok: false, error: "bad_address" });
  assertEquals(parseInquiry({ kind: "address", address: "x", email: "not-an-email" }), { ok: false, error: "bad_email" });
  assertEquals(parseInquiry({ kind: "lookup", address: "x", email: "a@b.co" }), { ok: false, error: "bad_kind" });
  assertEquals(parseInquiry({ kind: "business", email: "a@b.co" }), { ok: false, error: "bad_company" });
  const biz = parseInquiry({ kind: "business", company: "Acme", email: "a@b.co", properties: "12", bills: ["utilities", "cable", "utilities", 3] });
  assertEquals(biz.ok && biz.row.properties, 12);
  assertEquals(biz.ok && biz.row.bills, ["utilities"]);
  assertEquals(parseInquiry(null).ok, false);
  assertEquals(parseInquiry({ kind: "appeal", address: "x".repeat(300), email: "a@b.co" }).ok && (parseInquiry({ kind: "appeal", address: "x".repeat(300), email: "a@b.co" }) as { row: { address: string } }).row.address.length, 200);
});

Deno.test("portal: stage per status and the timeline from the rows we keep (SPEC-07 §10)", () => {
  assertEquals(["submitted", "processing", "needs_review", "needs_dl_update"].map(stageIndex), [0, 0, 0, 0]);
  assertEquals([stageIndex("ready_to_submit"), stageIndex("filed"), stageIndex("approved"), stageIndex("denied"), stageIndex("refunded"), stageIndex("paid")], [1, 3, 4, 4, 5, 5]);
  const t = timelineFrom({ created_at: "2026-09-02T10:00:00Z", processed_at: "2026-09-02T10:01:00Z", filing: { submitted_at: "2026-09-04T09:00:00Z", approved_at: null, denied_at: null }, refund_observed_at: null });
  assertEquals(t, { received: "2026-09-02T10:00:00Z", id_checked: "2026-09-02T10:01:00Z", approved: "2026-09-04T09:00:00Z", filed: "2026-09-04T09:00:00Z", decided: null, refunded: null });
  assertEquals(timelineFrom({ created_at: null, processed_at: null, filing: null, refund_observed_at: null }).filed, null);
  assertEquals(timelineFrom({ created_at: "a", processed_at: null, filing: { submitted_at: "b", approved_at: null, denied_at: "c" }, refund_observed_at: null }).decided, "c");
});
