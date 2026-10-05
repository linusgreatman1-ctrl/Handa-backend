// Thin wrapper around the Paystack REST API. Every call requires
// PAYSTACK_SECRET_KEY to be set — in its absence (e.g. local dev with no
// keys yet) callers get a clear error rather than a silent fake success,
// since this touches real money.
const PAYSTACK_BASE = "https://api.paystack.co";

function requireKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error("PAYSTACK_SECRET_KEY is not configured.");
    err.status = 503;
    throw err;
  }
  return key;
}

async function paystackFetch(path, options = {}) {
  const key = requireKey();
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.status === false) {
    const err = new Error(json.message || "Paystack request failed.");
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  return json.data;
}

// Resolves an account number + bank code to the account holder's real
// name, so a user can't type an arbitrary name next to someone else's
// account number when linking a payout account.
async function resolveBankAccount(accountNumber, bankCode) {
  return paystackFetch(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`, {
    method: "GET",
  });
}

async function listBanks() {
  return paystackFetch("/bank?country=nigeria", { method: "GET" });
}

// ── Test-mode checkout ──
// With DEV_BYPASS_PAYMENTS=true and no PAYSTACK_SECRET_KEY, Card/USSD open
// Handa's own test checkout page (payments.routes.js /dev-checkout) instead
// of failing outright -- same idea as Wallet/Bank Transfer's own test-mode
// bypass. Paying there marks the transaction successful, and it then runs
// through the exact same verify -> applyVerifiedPayment path a real
// Paystack payment does. Never active once a real key is configured.
const devTransactions = new Map(); // reference -> { email, amount, metadata, status }
function devCheckoutEnabled() {
  return !process.env.PAYSTACK_SECRET_KEY && process.env.DEV_BYPASS_PAYMENTS === "true";
}
function getDevTransaction(reference) {
  return devTransactions.get(reference) || null;
}
function markDevTransactionPaid(reference) {
  const t = devTransactions.get(reference);
  if (t) t.status = "success";
  return t;
}

// Initializes a hosted checkout for an order/booking/wallet-deposit —
// returns { authorization_url, access_code, reference } for the frontend
// to redirect to / open in Paystack's inline popup.
async function initializeTransaction({ email, amountKobo, reference, metadata, channel }) {
  if (devCheckoutEnabled()) {
    devTransactions.set(reference, { email, amount: amountKobo, metadata, channel: channel || "card", status: "pending" });
    return { authorization_url: `/api/payments/dev-checkout/${encodeURIComponent(reference)}`, access_code: "test", reference };
  }
  return paystackFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata, ...(channel ? { channels: [channel] } : {}), ...(process.env.PUBLIC_BASE_URL ? { callback_url: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/payments/return` } : {}) }),
  });
}

async function verifyTransaction(reference) {
  const dev = devTransactions.get(reference);
  if (dev) return { status: dev.status, reference, amount: dev.amount, metadata: dev.metadata };
  return paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
}

// Creates a transfer recipient (required once per bank account before any
// payout) then initiates the actual transfer — used for withdrawals and
// market-seller payouts.
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  return paystackFetch("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({ type: "nuban", name, account_number: accountNumber, bank_code: bankCode, currency: "NGN" }),
  });
}

async function initiateTransfer({ amountKobo, recipientCode, reason, reference }) {
  return paystackFetch("/transfer", {
    method: "POST",
    body: JSON.stringify({ source: "balance", amount: amountKobo, recipient: recipientCode, reason, reference }),
  });
}

module.exports = {
  devCheckoutEnabled,
  getDevTransaction,
  markDevTransactionPaid,
  resolveBankAccount,
  listBanks,
  initializeTransaction,
  verifyTransaction,
  createTransferRecipient,
  initiateTransfer,
};
