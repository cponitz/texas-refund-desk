// ops logic (SPEC-09 D1): the pure parts of the operator API, tested in logic_test.ts.
//   • the claim status transitions the operator may trigger (mirror of cleanbill/agent/store.py ALLOWED_TRANSITIONS)
//   • the guard for each mutating action
//   • the "we submitted" draft (copy/followups.md "filed — confirmation", verbatim with the placeholders filled)
//   • address matching for the walkthrough "new claim" search over the published properties
//   • the funnel step strip and the masking of the selftest result
//   • outbound e-mail (SPEC-10): the send guards, the packet attachment rule, the Resend payload, the feature flags

/** Mirror of cleanbill/agent/store.py ALLOWED_TRANSITIONS — change both. */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  submitted: ["processing", "needs_review", "withdrawn"],
  processing: ["ready_to_submit", "needs_dl_update", "needs_review", "withdrawn"],
  needs_dl_update: ["processing", "ready_to_submit", "needs_review", "withdrawn"],
  needs_review: ["processing", "ready_to_submit", "needs_dl_update", "withdrawn"],
  ready_to_submit: ["filed", "needs_review", "withdrawn"],
  filed: ["approved", "denied", "needs_review"],
  approved: ["refunded"],
  refunded: ["paid"],
};
export const OPEN_STATUSES = ["submitted", "processing", "needs_dl_update", "needs_review", "ready_to_submit"];
export const CLAIM_STATUSES = ["submitted", "processing", "ready_to_submit", "needs_dl_update", "needs_review", "filed", "approved", "denied", "refunded", "paid", "withdrawn"];
export const FILING_CHANNELS = ["email", "portal", "mail"] as const;
export type FilingChannel = (typeof FILING_CHANNELS)[number];
export const SELFTEST_SCENARIOS = ["match", "mismatch", "mismatch_then_fix", "card"];
export const MUTATING_ACTIONS = ["approve", "discard", "send", "mark_filed", "reprocess", "withdraw", "inquiry_handled", "new_claim", "run_selftest", "system_status"] as const;
export type OpsAction = (typeof MUTATING_ACTIONS)[number];

export function canTransition(from: string, to: string): boolean {
  return from === to || (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export type Guard = { ok: true; to: string | null } | { ok: false; error: string; status: number };

/** Whether an operator action is allowed from the claim's current status, and where it moves the claim. */
export function guardAction(action: "mark_filed" | "reprocess" | "withdraw", status: string): Guard {
  switch (action) {
    case "mark_filed":
      return status === "ready_to_submit" && canTransition(status, "filed") ? { ok: true, to: "filed" } : { ok: false, error: `mark_filed_not_allowed_from_${status}`, status: 409 };
    case "reprocess":
      return status === "submitted" || status === "processing" ? { ok: true, to: null } : { ok: false, error: `reprocess_not_allowed_from_${status}`, status: 409 };
    case "withdraw":
      return OPEN_STATUSES.includes(status) && canTransition(status, "withdrawn") ? { ok: true, to: "withdrawn" } : { ok: false, error: `withdraw_not_allowed_from_${status}`, status: 409 };
  }
}

export function parseChannel(v: unknown): FilingChannel {
  return (FILING_CHANNELS as readonly string[]).includes(String(v ?? "")) ? (v as FilingChannel) : "email";
}

const CHANNEL_TEXT: Record<FilingChannel, string> = { email: "e-mail", portal: "the TCAD online portal", mail: "mail" };

/** The "filed — confirmation" template from copy/followups.md, verbatim, with its placeholders filled. */
export function filedDraft(situs: string, submittedAt: Date, channel: FilingChannel): { intent: "filed"; subject: string; body: string } {
  const date = submittedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  return {
    intent: "filed",
    subject: "Submitted to TCAD — what happens next",
    body: `Your application for ${situs} was submitted to the Travis Central Appraisal District on ${date} via ${CHANNEL_TEXT[channel]}. They may take up to 90 days. If they ask for anything else, we'll handle it and let you know. Nothing is owed until a refund is actually issued.`,
  };
}

// ---- new-claim search (over the published `properties` rows; the Mac CLI keeps the full-roll case) -----------------
const DIRECTIONS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"]);

export function normAddress(s: string): string {
  return (s ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

/** Splits "3675 Duval St" into the house number, the first street word to search on, and every word to score with. */
export function addressKey(address: string): { num: string; key: string; words: string[] } {
  const a = normAddress(address);
  const m = a.match(/^(\d+[A-Z]?)\s+(.+)$/);
  const [num, rest] = m ? [m[1], m[2]] : ["", a];
  let words = rest.split(" ").filter(Boolean);
  if (words.length > 1 && DIRECTIONS.has(words[0])) words = words.slice(1);
  return { num, key: words[0] ?? "", words };
}

export function scoreMatch(situsFull: string, words: string[]): number {
  const ws = new Set(normAddress(situsFull).split(" "));   // whole words: "ST" must not match inside "AUSTIN"
  return words.reduce((n, w) => n + (ws.has(w) ? 1 : 0), 0);
}

export function claimLink(base: string, code: string): string {
  return `${base.replace(/\/$/, "")}/claim/${code}`;
}

// ---- funnel -------------------------------------------------------------------------------------------------------
export const FUNNEL_KINDS = ["view", "typed_precheck", "validation_shown", "dl_fix_started", "dl_fix_uploaded", "card_saved", "card_skipped", "packet_viewed", "inquiry"];

/** The step-conversion strip: page views → claimed → ready to submit → filed (counts from the KPIs, not from events). */
export function funnelSteps(k: { page_views: number; claimed: number; ready_to_submit: number; filed: number }): Array<{ step: string; count: number; pct: number | null }> {
  const steps = [["Page views", k.page_views], ["Claimed", k.claimed], ["Ready to submit", k.ready_to_submit], ["Filed", k.filed]] as Array<[string, number]>;
  return steps.map(([step, count], i) => {
    const prev = i === 0 ? null : steps[i - 1][1];
    return { step, count, pct: prev === null ? null : prev > 0 ? Math.round((count / prev) * 1000) / 10 : 0 };
  });
}

export function parseLimit(v: string | null, dflt = 200, max = 500): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
}

/** The selftest result as the dashboard may show it: no IP addresses. */
export function maskSelftest(j: unknown): unknown {
  return JSON.parse(JSON.stringify(j).replace(/"signature_ip":"[^"]*"/g, '"signature_ip":"…"'));
}

// ---- outbound e-mail (SPEC-10; ADR 0022) ---------------------------------------------------------------------------
// Every send is an operator's click on an approved message (B-10 shadow mode); the agent has no send tool.
export type SendableMessage = { id: string; direction: string; channel: string; agent_draft: boolean | null; sent_at: string | null; intent: string | null; subject: string | null; body: string | null };
export type SendGuard = { ok: true } | { ok: false; error: string; status: number };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v: unknown): v is string => typeof v === "string" && EMAIL_RE.test(v.trim());

/** Why a message may not go out. `enabled` is RESEND_ENABLED === "true" (409 send_disabled when off — Send is hidden then).
 *  A concurrent double-click passes this guard twice; the `update … where sent_at is null` in the action and Resend's
 *  Idempotency-Key make the second call return already_sent without a second e-mail. */
export function guardSend(m: SendableMessage | null, accountEmail: unknown, enabled: boolean): SendGuard {
  if (!enabled) return { ok: false, error: "send_disabled", status: 409 };
  if (!m) return { ok: false, error: "not_found", status: 404 };
  if (m.direction !== "outbound") return { ok: false, error: "not_outbound", status: 409 };
  if (m.channel !== "email") return { ok: false, error: "not_email", status: 409 };
  if (m.agent_draft !== false) return { ok: false, error: "draft_not_approved", status: 409 };
  if (m.sent_at) return { ok: false, error: "already_sent", status: 409 };
  if (!isEmail(accountEmail)) return { ok: false, error: "no_email", status: 409 };
  if (!m.subject?.trim() || !m.body?.trim()) return { ok: false, error: "empty_message", status: 409 };
  return { ok: true };
}

/** Intents whose e-mail carries the filled Form 50-114 when the claim has a packet. */
export const ATTACH_INTENTS = ["ready_to_submit", "filed"];
/** Resend accepts 40 MB after base64; we refuse above 20 MB of PDF (the packets bucket caps files at 25 MB anyway). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function attachmentName(claimCode: string | null | undefined): string {
  return `Form-50-114-${(claimCode ?? "packet").replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
}

/** The storage path and filename to attach, or null when this message carries no packet. */
export function attachmentPlan(intent: string | null, packetPath: string | null | undefined, claimCode: string | null | undefined): { path: string; filename: string } | null {
  if (!intent || !ATTACH_INTENTS.includes(intent) || !packetPath) return null;
  return { path: packetPath, filename: attachmentName(claimCode) };
}

const tagValue = (v: string | null | undefined) => (v ?? "none").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);   // Resend: ASCII letters, digits, _ and - only

export type ResendPayload = {
  from: string; to: string[]; reply_to: string; subject: string; html: string; text: string;
  attachments?: Array<{ filename: string; content: string }>;
  tags: Array<{ name: string; value: string }>; headers: Record<string, string>;
};

/** The body of POST /emails. `from` is "<brand> <support e-mail>" and replies go to the same human inbox (B-19, O-08). */
export function resendPayload(a: { brand: string; supportEmail: string; to: string; subject: string; html: string; text: string; attachment?: { filename: string; content: string } | null; intent: string | null; claimCode: string | null | undefined; messageId: string }): ResendPayload {
  const p: ResendPayload = {
    from: `${a.brand} <${a.supportEmail}>`, to: [a.to.trim()], reply_to: a.supportEmail, subject: a.subject, html: a.html, text: a.text,
    tags: [{ name: "intent", value: tagValue(a.intent) }, { name: "claim_code", value: tagValue(a.claimCode) }],
    headers: { "X-Entity-Ref-ID": a.messageId },
  };
  if (a.attachment) p.attachments = [a.attachment];
  return p;
}

/** Which vendors are switched on, from the function secrets (RESEND_ENABLED; STRIPE_ENABLED and LOB_ENABLED are SPEC-03 / SPEC-11). */
export function featureFlags(env: (k: string) => string | undefined): { resend: boolean; stripe: boolean; lob: boolean } {
  const on = (k: string) => env(k) === "true";
  return { resend: on("RESEND_ENABLED"), stripe: on("STRIPE_ENABLED"), lob: on("LOB_ENABLED") };
}
