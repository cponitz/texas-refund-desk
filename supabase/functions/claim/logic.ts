// Pure decision logic for the claim API (no I/O) so it can be unit-tested in Deno (logic_test.ts):
//   * which follow-up a POST on an existing claim is (SPEC-02 re-upload / SPEC-06 typed confirmation) or 409
//   * the typed address pre-check (SPEC-06 §3)
//   * the shape of a `typed_id` document's `extracted` blob (SPEC-06 §3/§4)
//   * the funnel events the page may post (SPEC-06 §5, SPEC-02 §5)
import type { Finding } from "../_shared/findings.ts";
import { addressMatches, type Extracted, type PropertyRec } from "../_shared/validate.ts";

export const PAGE_EVENTS = ["validation_shown", "dl_fix_started", "dl_fix_uploaded", "typed_precheck", "card_skipped", "packet_viewed"] as const;   // card_saved is server-written (SPEC-03 §3 item 2)
export type PageEvent = typeof PAGE_EVENTS[number];
export const isPageEvent = (k: string): k is PageEvent => (PAGE_EVENTS as readonly string[]).includes(k);

/** Findings that let the customer confirm typed values instead of a re-shoot (SPEC-06 §4). */
export const TYPED_FALLBACK_CODES = ["not_readable", "low_confidence"];

export type FollowUp = { mode: "reupload" } | { mode: "typed_confirm" } | { error: "conflict"; http: 409; reason: string };

/** A POST for a code whose lead is already `claimed`: re-upload (needs_dl_update + dl_front), typed confirmation
 *  (needs_review with a fallback code + typed fields), otherwise 409 (SPEC-02 acceptance). */
export function followUpMode(p: { status: string; findings: Finding[] | null | undefined; hasFront: boolean; hasTyped: boolean }): FollowUp {
  if (p.hasFront) {
    if (p.status === "needs_dl_update") return { mode: "reupload" };
    return { error: "conflict", http: 409, reason: `a new license is only accepted while the claim is needs_dl_update (current status: ${p.status})` };
  }
  if (p.hasTyped) {
    const codes = (p.findings ?? []).map((f) => String(f.code));
    if (p.status === "needs_review" && codes.some((c) => TYPED_FALLBACK_CODES.includes(c))) return { mode: "typed_confirm" };
    return { error: "conflict", http: 409, reason: `typed confirmation is only accepted while the claim is needs_review for an unreadable or low-confidence license (current status: ${p.status})` };
  }
  return { error: "conflict", http: 409, reason: "a claim already exists for this code; send dl_front to re-upload a license, or the typed_* fields to confirm one" };
}

/** SPEC-06 §3: `addressMatches` only — the cheap check the page runs on blur before the photo step. */
export function precheck(address: string | null, zip: string | null, prop: PropertyRec): { match: boolean; id_address: string; situs: string } {
  const a = (address ?? "").trim().replace(/\s+/g, " "), z = (zip ?? "").trim().slice(0, 5);
  return { match: !!a && addressMatches(a, z, prop), id_address: [a, z].filter(Boolean).join(", "), situs: prop.situs_full };
}

export type TypedFields = { first_name?: string; last_name?: string; dob?: string; address_line1?: string; city?: string; zip?: string };
const TYPED_KEYS: Array<[keyof TypedFields, string]> = [
  ["first_name", "typed_first_name"], ["last_name", "typed_last_name"], ["dob", "typed_dob"],
  ["address_line1", "typed_address"], ["city", "typed_city"], ["zip", "typed_zip"],
];

/** Reads the typed_* form fields; `typed_name` ("First M Last") is split when first/last are not given. Null when none typed. */
export function parseTypedFields(get: (k: string) => string): TypedFields | null {
  const t: TypedFields = {};
  for (const [k, form] of TYPED_KEYS) { const v = get(form); if (v) t[k] = v; }
  const name = get("typed_name");
  if (name && !t.first_name && !t.last_name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) { t.last_name = parts[parts.length - 1]; t.first_name = parts.slice(0, -1).join(" "); }
    else if (parts.length === 1) t.first_name = parts[0];
  }
  if (t.dob && !/^\d{4}-\d{2}-\d{2}$/.test(t.dob)) delete t.dob;
  if (t.zip) t.zip = t.zip.replace(/\D/g, "").slice(0, 5);
  return Object.keys(t).length ? t : null;
}

/** The `extracted` blob of a `typed_id` document: same 13-field shape, confidence 1.0 on typed fields, source "typed". */
export function typedExtracted(t: TypedFields, base?: Partial<Extracted>): Extracted {
  const has = (k: keyof TypedFields) => !!t[k];
  const c = base?.confidence ?? { name: 0, dob: 0, address: 0, dl_number: 0, expiry: 0 };
  return {
    readable: true, id_type: base?.id_type ?? "driver_license", issuing_state: base?.issuing_state ?? "TX",
    first_name: t.first_name ?? base?.first_name ?? "", middle_name: base?.middle_name ?? "", last_name: t.last_name ?? base?.last_name ?? "",
    dob: t.dob ?? base?.dob ?? "", expiry: base?.expiry ?? "", dl_number: base?.dl_number ?? "",
    address_line1: t.address_line1 ?? base?.address_line1 ?? "", city: t.city ?? base?.city ?? "", state: base?.state ?? "TX", zip: t.zip ?? base?.zip ?? "",
    confidence: {
      name: has("first_name") || has("last_name") ? 1.0 : c.name, dob: has("dob") ? 1.0 : c.dob,
      address: has("address_line1") || has("zip") || has("city") ? 1.0 : c.address, dl_number: c.dl_number, expiry: c.expiry,
    },
    issues: base?.issues ?? [], source: "typed",
  };
}

export function extFor(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "application/pdf" ? "pdf" : mime === "image/heic" || mime === "image/heif" ? "heic" : "jpg";
}

// ---- SPEC-07 (website redesign): inbound inquiries and the portal view of a claim ---------------------------------

export const INQUIRY_KINDS = ["address", "exemption", "appeal", "business"] as const;
export type InquiryKind = typeof INQUIRY_KINDS[number];
export const BILL_KINDS = ["property_tax", "utilities", "insurance", "telecom"] as const;
export type Inquiry = {
  kind: InquiryKind; address: string | null; email: string | null; company: string | null; properties: number | null;
  bills: string[]; source_path: string | null;
};
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Validate a public-site form post (`POST /claim/inquiry`). Returns the row to store, or the first problem.
 *  Homeowner kinds need an address and an e-mail (we answer by e-mail, B-04); the business kind needs a work e-mail. */
export function parseInquiry(body: unknown): { ok: true; row: Inquiry } | { ok: false; error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const str = (k: string, max: number) => { const v = typeof b[k] === "string" ? (b[k] as string).trim().slice(0, max) : ""; return v || null; };
  const kind = String(b.kind ?? "");
  if (!(INQUIRY_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "bad_kind" };
  const email = str("email", 200);
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: "bad_email" };
  const address = str("address", 200);
  const company = str("company", 200);
  const rawProps = Number(b.properties);
  const properties = Number.isInteger(rawProps) && rawProps > 0 && rawProps < 100_000 ? rawProps : null;
  const bills = Array.isArray(b.bills) ? [...new Set(b.bills.filter((x): x is string => typeof x === "string" && (BILL_KINDS as readonly string[]).includes(x)))] : [];
  const source_path = str("source_path", 100);
  if (kind !== "business" && !address) return { ok: false, error: "bad_address" };
  if (kind === "business" && !company) return { ok: false, error: "bad_company" };
  return { ok: true, row: { kind: kind as InquiryKind, address, email, company, properties, bills, source_path } };
}

/** The six portal stages (SPEC-07 §10) and which one each claim status has reached. `-1` = none (cancelled / denied
 *  keep the stages they passed, so the page can grey the rest). Stage index: 0 received · 1 id_checked · 2 you approved
 *  · 3 submitted to TCAD · 4 TCAD decision · 5 refund issued. */
export function stageIndex(status: string): number {
  switch (status) {
    case "submitted": case "processing": case "needs_review": case "needs_dl_update": return 0;
    case "ready_to_submit": return 1;
    case "filed": return 3;
    case "approved": case "denied": return 4;
    case "refunded": case "paid": return 5;
    case "withdrawn": return 0;
    default: return 0;
  }
}

export type Timeline = { received: string | null; id_checked: string | null; approved: string | null; filed: string | null; decided: string | null; refunded: string | null };

/** Dates for the portal's progress row from the rows we keep: the claim, its latest filing, the first process-claim audit
 *  row and the earliest observed refund. Only dates we actually have are filled; the page shows expectations otherwise. */
export function timelineFrom(p: {
  created_at: string | null; processed_at: string | null;
  filing: { submitted_at: string | null; approved_at: string | null; denied_at: string | null } | null;
  refund_observed_at: string | null;
}): Timeline {
  return {
    received: p.created_at,
    id_checked: p.processed_at,
    approved: p.filing?.submitted_at ?? null,   // the customer's "go" precedes the submission; we keep no separate stamp
    filed: p.filing?.submitted_at ?? null,
    decided: p.filing?.approved_at ?? p.filing?.denied_at ?? null,
    refunded: p.refund_observed_at,
  };
}
