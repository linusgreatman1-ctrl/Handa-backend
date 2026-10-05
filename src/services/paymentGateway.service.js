// The app's single entry point for card/USSD payments and payouts, with two
// gateways underneath: Paystack and Flutterwave. Callers use the same
// functions they always did (initializeTransaction / verifyTransaction /
// listBanks / resolveBankAccount / createTransferRecipient / initiateTransfer);
// this file decides which gateway handles each one.
//
// Every checkout is recorded as a PaymentIntent (gateway, amount due, what
// it is for) before the customer pays. Verifying always goes back to the
// same gateway it was paid on, and a payment only counts as successful if
// that gateway says so, in NGN, for at least the amount due -- the metadata
// that routes it comes from our own record, never from the gateway reply.
const prisma = require("../config/db");
const paystack = require("./paystack.service");
const flutterwave = require("./flutterwave.service");

const GATEWAYS = ["paystack", "flutterwave"];

function available() {
  return { paystack: !!process.env.PAYSTACK_SECRET_KEY, flutterwave: flutterwave.isConfigured() };
}

// The customer's choice if that gateway is set up, otherwise whichever is.
// With neither set up, Paystack's own test checkout (DEV_BYPASS_PAYMENTS)
// still works, so "paystack" is the fallback.
function pick(requested) {
  const a = available();
  const want = String(requested || "").toLowerCase();
  if (GATEWAYS.includes(want) && a[want]) return want;
  if (a.paystack) return "paystack";
  if (a.flutterwave) return "flutterwave";
  return "paystack";
}

async function initializeTransaction({ email, amountKobo, reference, metadata, gateway, channel }) {
  const gw = pick(gateway);
  await prisma.paymentIntent.upsert({
    where: { reference },
    create: { reference, gateway: gw, amountKobo, metadata: metadata || {}, email: email || null },
    update: { gateway: gw, amountKobo, metadata: metadata || {}, email: email || null },
  });
  const impl = gw === "flutterwave" ? flutterwave : paystack;
  const data = await impl.initializeTransaction({ email, amountKobo, reference, metadata, channel });
  return { ...data, gateway: gw };
}

// -> { status, reference, amount (kobo), metadata, gateway }
async function verifyTransaction(reference) {
  const intent = await prisma.paymentIntent.findUnique({ where: { reference } });
  if (!intent) {
    // A Paystack checkout started before PaymentIntents existed.
    const d = await paystack.verifyTransaction(reference);
    return { ...d, gateway: "paystack" };
  }
  let status, paidKobo, currency;
  if (intent.gateway === "flutterwave") {
    const d = await flutterwave.verifyTransaction(reference);
    status = d.status; paidKobo = d.amountKobo; currency = d.currency;
  } else {
    const d = await paystack.verifyTransaction(reference);
    status = d.status; paidKobo = Number(d.amount || 0); currency = d.currency || "NGN";
  }
  const ok = status === "success" && currency === "NGN" && paidKobo >= intent.amountKobo;
  return { status: ok ? "success" : status === "success" ? "amount_mismatch" : status, reference, amount: intent.amountKobo, metadata: intent.metadata, gateway: intent.gateway };
}

// Marks a reference as applied; false if it already was -- so a payment is
// credited exactly once however many times it gets verified.
async function claimApplication(reference) {
  const r = await prisma.paymentIntent.updateMany({ where: { reference, appliedAt: null }, data: { appliedAt: new Date() } });
  if (r.count === 1) return true;
  const exists = await prisma.paymentIntent.findUnique({ where: { reference }, select: { id: true } });
  return !exists; // no record (pre-PaymentIntent Paystack checkout): let it through as before
}
async function releaseApplication(reference) {
  await prisma.paymentIntent.updateMany({ where: { reference }, data: { appliedAt: null } });
}

// Banks, account lookup and payouts go through one gateway: Paystack when
// it is set up, otherwise Flutterwave.
function payoutGateway() {
  return available().paystack || !flutterwave.isConfigured() ? paystack : flutterwave;
}
const listBanks = (...a) => payoutGateway().listBanks(...a);
const resolveBankAccount = (...a) => payoutGateway().resolveBankAccount(...a);
const createTransferRecipient = (...a) => payoutGateway().createTransferRecipient(...a);
const initiateTransfer = (...a) => payoutGateway().initiateTransfer(...a);

module.exports = {
  available,
  pick,
  initializeTransaction,
  verifyTransaction,
  claimApplication,
  releaseApplication,
  listBanks,
  resolveBankAccount,
  createTransferRecipient,
  initiateTransfer,
  // Paystack's test checkout (DEV_BYPASS_PAYMENTS, no keys) -- unchanged.
  devCheckoutEnabled: paystack.devCheckoutEnabled,
  getDevTransaction: paystack.getDevTransaction,
  markDevTransactionPaid: paystack.markDevTransactionPaid,
};
