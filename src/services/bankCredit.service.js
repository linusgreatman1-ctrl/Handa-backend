// Automatic confirmation of bank-transfer payments (the same mechanism as on PassNow and Learnza).
//
// When someone pays by bank transfer, a ManualPaymentRequest is recorded as PENDING and an admin used to confirm it by hand once the
// money was seen. Now, when the money really arrives in the company account, a bank / payment-provider feed (Flutterwave or Paystack
// virtual-account transfers, Monnify, a bank alert service, ...) calls Handa's bank-credit webhook with the amount. This service then
// finds the waiting request that credit belongs to and confirms it through confirmManualPaymentRequest() - the very function the
// admin's "Confirm" button uses - so nothing can be confirmed twice.
//
// How a credit is matched to a request:
//   1. the narration (the payer's note) holds the request's reference -> that request (if the amount covers it);
//   2. otherwise the requests waiting for exactly that amount: one -> that one; several -> the one whose account holder's name
//      shares a name with the payer's; still more than one (or none) -> nothing is confirmed and the admins are told.
const crypto = require("crypto");
const prisma = require("../config/db");
const manualPayments = require("./manualPayments.service");
const { notifyAllAdmins } = require("./notifications.service");

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;     // a request older than this is no longer waiting for money
const naira = (kobo) => "₦" + Math.round(kobo / 100).toLocaleString("en-NG");

// ── what each feed sends, put into one shape ────────────────────────────
function normalize(provider, body) {
  const p = String(provider || "generic").toLowerCase();
  const b = body || {};
  if (p === "flutterwave") {
    const d = b.data || {};
    if (!/charge\.completed/i.test(b.event || b["event.type"] || "charge.completed") || String(d.status || "").toLowerCase() !== "successful") return null;
    if (d.payment_type && !/bank|transfer|ussd/i.test(d.payment_type)) return null;
    return { provider: "FLUTTERWAVE", providerRef: "FLW-" + (d.id || d.flw_ref || d.tx_ref), amountKobo: Math.round(Number(d.amount) * 100), narration: [d.narration, d.tx_ref, d.flw_ref].filter(Boolean).join(" "), payerName: (d.customer && d.customer.name) || d.account_name || "" };
  }
  if (p === "paystack") {
    const d = b.data || {};
    if (b.event !== "charge.success" || d.status !== "success") return null;
    if (d.channel && !/bank|dedicated/i.test(d.channel)) return null;
    return { provider: "PAYSTACK", providerRef: "PSK-" + (d.id || d.reference), amountKobo: Number(d.amount), narration: [d.reference, d.authorization && d.authorization.narration, d.metadata && d.metadata.narration].filter(Boolean).join(" "), payerName: (d.authorization && (d.authorization.sender_name || d.authorization.account_name)) || (d.customer && [d.customer.first_name, d.customer.last_name].filter(Boolean).join(" ")) || "" };
  }
  if (p === "monnify") {
    const d = b.eventData || b;
    if (b.eventType && !/SUCCESSFUL_TRANSACTION/i.test(b.eventType)) return null;
    if (d.paymentStatus && d.paymentStatus !== "PAID") return null;
    return { provider: "MONNIFY", providerRef: "MNF-" + (d.transactionReference || d.paymentReference), amountKobo: Math.round(Number(d.amountPaid || d.settlementAmount) * 100), narration: [d.paymentReference, d.paymentDescription, d.product && d.product.reference].filter(Boolean).join(" "), payerName: (d.customer && d.customer.name) || (d.paymentSourceInformation && d.paymentSourceInformation[0] && d.paymentSourceInformation[0].accountName) || "" };
  }
  // generic: { id, amount (naira) | amountKobo, narration, name }
  if (!b.id && !b.reference) return null;
  const kobo = b.amountKobo != null ? Number(b.amountKobo) : Math.round(Number(b.amount) * 100);
  return { provider: "GENERIC", providerRef: "GEN-" + (b.id || b.reference), amountKobo: kobo, narration: String(b.narration || b.description || ""), payerName: String(b.name || b.sender || "") };
}

// Is this call really from the feed's owner? Each feed signs its calls in its own way; the generic one uses BANK_WEBHOOK_SECRET.
function verifySignature(provider, req) {
  const p = String(provider || "generic").toLowerCase();
  const h = req.headers || {};
  const safe = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  const flwHash = process.env.FLUTTERWAVE_WEBHOOK_HASH || process.env.FLW_SECRET_HASH;
  if (p === "flutterwave") return !!flwHash && safe(h["verif-hash"], flwHash);
  if (p === "paystack") {
    if (!process.env.PAYSTACK_SECRET_KEY || !req.rawBody) return false;
    return safe(crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex"), h["x-paystack-signature"]);
  }
  if (p === "monnify") {
    if (!process.env.MONNIFY_SECRET_KEY || !req.rawBody) return false;
    return safe(crypto.createHmac("sha512", process.env.MONNIFY_SECRET_KEY).update(req.rawBody).digest("hex"), h["monnify-signature"]);
  }
  if (!process.env.BANK_WEBHOOK_SECRET) return false;
  return safe(h["x-bank-secret"] || (req.query && req.query.secret), process.env.BANK_WEBHOOK_SECRET);
}

// ── the requests that are waiting for money ─────────────────────────────
async function waiting(now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await prisma.manualPaymentRequest.findMany({ where: { status: "PENDING", createdAt: { gt: since } }, include: { user: { select: { name: true, phone: true } } } });
  return rows.map((r) => ({ kind: "MANUAL", id: r.id, ref: r.reference, amountKobo: r.amountKobo, holder: r.user && r.user.name, contact: r.user && r.user.phone, createdAt: r.createdAt, label: String(r.purpose || "").replace(/_/g, " ").toLowerCase() }));
}

const words = (t) => new Set((String(t || "").toLowerCase().match(/[a-z]{3,}/g) || []));
function sharesName(a, b) { const x = words(a), y = words(b); for (const w of x) if (y.has(w)) return true; return false; }

// Which request does this credit belong to? -> { request } | { ambiguous: [...] } | { none: true }
function choose(credit, requests) {
  const text = String(credit.narration || "").toLowerCase();
  const byRef = requests.filter((r) => r.ref && text.includes(String(r.ref).toLowerCase()) && credit.amountKobo >= r.amountKobo);
  if (byRef.length === 1) return { request: byRef[0], how: "reference" };
  const same = requests.filter((r) => r.amountKobo === credit.amountKobo);
  if (same.length === 1) return { request: same[0], how: "amount" };
  if (same.length > 1) {
    const named = same.filter((r) => sharesName(r.holder, credit.payerName));
    if (named.length === 1) return { request: named[0], how: "amount and name" };
    return { ambiguous: same };
  }
  return { none: true };
}

// Confirms one waiting request, through the very function the admin's Confirm button uses.
async function confirmRequest(r, io) {
  try { await manualPayments.confirmManualPaymentRequest(r.id, null, io); return { ok: true }; }
  catch (err) { return { ok: false, reason: (err && err.message) || "failed" }; }
}

// A credit has been reported. Safe to call twice with the same credit: the second is ignored.
async function processCredit(credit, io, now = new Date()) {
  if (!credit || !credit.providerRef || !Number.isFinite(credit.amountKobo) || credit.amountKobo <= 0) return { ok: false, reason: "invalid" };
  const seen = await prisma.bankCredit.findUnique({ where: { providerRef: credit.providerRef } });
  if (seen) return { ok: true, duplicate: true, status: seen.status };
  let row;
  try {
    row = await prisma.bankCredit.create({ data: { provider: credit.provider, providerRef: credit.providerRef, amountKobo: credit.amountKobo, narration: credit.narration ? String(credit.narration).slice(0, 300) : null, payerName: credit.payerName ? String(credit.payerName).slice(0, 120) : null } });
  } catch (err) { if (err && err.code === "P2002") return { ok: true, duplicate: true }; throw err; }

  const pick = choose(credit, await waiting(now));
  if (pick.request) {
    const r = await confirmRequest(pick.request, io);
    if (r.ok) {
      await prisma.bankCredit.update({ where: { id: row.id }, data: { status: "MATCHED", matchedRef: pick.request.ref, note: "Confirmed by the system (" + pick.how + ")" } });
      await notifyAllAdmins(io, "✅ Transfer confirmed automatically", `${naira(credit.amountKobo)} arrived${credit.payerName ? " from " + credit.payerName : ""} and was matched to ${pick.request.holder || "a customer"}'s ${pick.request.label}.`, { manualPaymentRequestId: pick.request.id });
      return { ok: true, status: "MATCHED", ref: pick.request.ref };
    }
    await prisma.bankCredit.update({ where: { id: row.id }, data: { status: "UNMATCHED", note: "The request could not be confirmed: " + r.reason } });
    await notifyAllAdmins(io, "⚠️ Money arrived but the transfer could not be confirmed", `${naira(credit.amountKobo)} arrived (${r.reason}). Please check Manual Bank Transfers.`, {});
    return { ok: true, status: "UNMATCHED" };
  }
  if (pick.ambiguous) {
    await prisma.bankCredit.update({ where: { id: row.id }, data: { status: "AMBIGUOUS", note: pick.ambiguous.length + " requests wait for this amount" } });
    await notifyAllAdmins(io, "❓ Money arrived — which transfer is it?", `${naira(credit.amountKobo)} arrived${credit.payerName ? " from " + credit.payerName : ""}, and ${pick.ambiguous.length} transfers wait for that amount. Please match it in Manual Bank Transfers.`, {});
    return { ok: true, status: "AMBIGUOUS" };
  }
  await prisma.bankCredit.update({ where: { id: row.id }, data: { status: "UNMATCHED", note: "No request is waiting for this amount" } });
  await notifyAllAdmins(io, "❓ Money arrived without a request", `${naira(credit.amountKobo)} arrived${credit.payerName ? " from " + credit.payerName : ""} and no transfer is waiting for it.`, {});
  return { ok: true, status: "UNMATCHED" };
}

// An admin matches a kept credit to a request by hand.
async function matchByHand(creditId, requestId, io) {
  const row = await prisma.bankCredit.findUnique({ where: { id: creditId } });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "MATCHED") return { ok: false, reason: "already_matched" };
  const req = (await waiting()).find((r) => r.id === requestId);
  if (!req) return { ok: false, reason: "request_not_waiting" };
  const r = await confirmRequest(req, io);
  if (!r.ok) return { ok: false, reason: r.reason };
  await prisma.bankCredit.update({ where: { id: row.id }, data: { status: "MATCHED", matchedRef: req.ref, note: "Matched by an admin" } });
  return { ok: true };
}

module.exports = { normalize, verifySignature, processCredit, choose, waiting, matchByHand };
