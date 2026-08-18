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

// Initializes a hosted checkout for an order/booking/wallet-deposit —
// returns { authorization_url, access_code, reference } for the frontend
// to redirect to / open in Paystack's inline popup.
async function initializeTransaction({ email, amountKobo, reference, metadata }) {
  return paystackFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata }),
  });
}

async function verifyTransaction(reference) {
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
  resolveBankAccount,
  listBanks,
  initializeTransaction,
  verifyTransaction,
  createTransferRecipient,
  initiateTransfer,
};
