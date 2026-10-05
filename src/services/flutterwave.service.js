// Thin wrapper around the Flutterwave v3 REST API -- the second card/USSD
// gateway alongside Paystack (see paymentGateway.service.js, which picks
// between them). Every call requires FLW_SECRET_KEY; without it callers get
// a clear error rather than a silent fake success, since this is money.
// Amounts in and out of this file are KOBO; Flutterwave itself uses naira.
const FLW_BASE = "https://api.flutterwave.com/v3";

function isConfigured() {
  return !!process.env.FLW_SECRET_KEY;
}

function requireKey() {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) {
    const err = new Error("FLW_SECRET_KEY is not configured.");
    err.status = 503;
    throw err;
  }
  return key;
}

async function flwFetch(path, options = {}) {
  const key = requireKey();
  const fetch = (await import("node-fetch")).default;
  let res;
  try {
    res = await fetch(`${FLW_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (netErr) {
    const err = new Error("Couldn't reach Flutterwave right now — please try again or choose another payment method.");
    err.status = 502;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error") {
    const err = new Error(json.message || "Flutterwave request failed.");
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    throw err;
  }
  return json.data;
}

function appBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "https://handa-backend-api-production-a9c3.up.railway.app").replace(/\/$/, "");
}

// Hosted checkout -> { authorization_url, reference }. Flutterwave sends the
// customer back to /api/payments/return when they finish.
async function initializeTransaction({ email, amountKobo, reference, metadata, channel }) {
  const data = await flwFetch("/payments", {
    method: "POST",
    body: JSON.stringify({
      tx_ref: reference,
      amount: Math.round(amountKobo) / 100,
      currency: "NGN",
      redirect_url: `${appBaseUrl()}/api/payments/return`,
      payment_options: channel || "card,ussd",
      customer: { email: email || "customer@handa.app" },
      meta: { purpose: metadata && metadata.purpose },
      customizations: { title: "Handa", description: "Secure payment into Handa escrow" },
    }),
  });
  return { authorization_url: data.link, reference };
}

// -> { status: "success" | "pending" | other, amountKobo, currency, reference }
async function verifyTransaction(reference) {
  let data;
  try {
    data = await flwFetch(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, { method: "GET" });
  } catch (err) {
    if (err.status === 503) throw err;
    return { status: "pending", amountKobo: 0, currency: null, reference };
  }
  return {
    status: data.status === "successful" && data.tx_ref === reference ? "success" : data.status || "failed",
    amountKobo: Math.round(Number(data.amount || 0) * 100),
    currency: data.currency,
    reference,
  };
}

async function listBanks() {
  const data = await flwFetch("/banks/NG", { method: "GET" });
  return (data || []).map((b) => ({ name: b.name, code: b.code, id: b.id })).sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveBankAccount(accountNumber, bankCode) {
  const data = await flwFetch("/accounts/resolve", {
    method: "POST",
    body: JSON.stringify({ account_number: String(accountNumber), account_bank: String(bankCode) }),
  });
  return { account_name: data.account_name, account_number: data.account_number };
}

// Flutterwave pays straight to a bank account (no separate recipient step),
// so the "recipient" just carries the account details to initiateTransfer.
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  requireKey();
  return { recipient_code: JSON.stringify({ name, accountNumber: String(accountNumber), bankCode: String(bankCode) }) };
}

async function initiateTransfer({ amountKobo, recipientCode, reason, reference }) {
  const r = JSON.parse(recipientCode);
  const data = await flwFetch("/transfers", {
    method: "POST",
    body: JSON.stringify({
      account_bank: r.bankCode,
      account_number: r.accountNumber,
      amount: Math.round(amountKobo) / 100,
      currency: "NGN",
      narration: reason || "Handa payout",
      reference,
      beneficiary_name: r.name,
    }),
  });
  // transfer_code is what withdrawals / seller payouts store to match the
  // later "transfer.completed" webhook.
  return { transfer_code: "flw_" + String(data.id), status: data.status, reference: data.reference };
}

module.exports = { isConfigured, initializeTransaction, verifyTransaction, listBanks, resolveBankAccount, createTransferRecipient, initiateTransfer };
