// Money that arrives in the company account confirms the matching waiting bank transfer by itself (services/bankCredit.service.js).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const crypto = require("crypto");

let seq = 0;
function table(unique = []) {
  const rows = [];
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return row[k] !== v.not;
      if ("gt" in v) return row[k] != null && new Date(row[k]) > new Date(v.gt);
      if ("in" in v) return v.in.includes(row[k]);
      return true;
    }
    return row[k] === v;
  });
  return {
    rows,
    async create({ data }) {
      const row = { id: "i" + ++seq, createdAt: new Date(), status: "PENDING", ...data };
      for (const u of unique) if (rows.some((r) => u.every((f) => r[f] === row[f]))) { const e = new Error("unique"); e.code = "P2002"; throw e; }
      rows.push(row); return { ...row };
    },
    async findUnique({ where }) { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
    async findMany({ where, include } = {}) { return rows.filter((r) => match(r, where)).map((r) => ({ ...r, ...(include && include.user ? { user: { name: r.holder, phone: r.contact } } : {}) })); },
    async update({ where, data }) { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return { ...r }; },
  };
}
const db = {
  bankCredit: table([["providerRef"]]),
  manualPaymentRequest: table(),
  user: { findMany: async () => [{ id: "admin1" }] },
  notification: table(), notificationPreference: { findUnique: async () => null },
};
const dbPath = require.resolve(path.join("..", "src", "config", "db.js"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

// the function the admin's Confirm button uses is replaced by a record of what it was asked to do
const manual = require("../src/services/manualPayments.service");
const confirmed = [];
manual.confirmManualPaymentRequest = async (id) => { confirmed.push(id); const r = db.manualPaymentRequest.rows.find((x) => x.id === id); if (r.status !== "PENDING") throw new Error("already " + r.status); r.status = "CONFIRMED"; return r; };
const bank = require("../src/services/bankCredit.service");

const request = (reference, amountKobo, holder) => db.manualPaymentRequest.rows.push({ id: "r" + ++seq, reference, amountKobo, holder, contact: "080", purpose: "WALLET_DEPOSIT", status: "PENDING", createdAt: new Date() });

test("each feed's call is put into one shape, and only successful bank transfers count", () => {
  const f = bank.normalize("flutterwave", { event: "charge.completed", data: { id: 77, status: "successful", amount: 13500, payment_type: "bank_transfer", customer: { name: "Ada Okoro" } } });
  assert.equal(f.amountKobo, 1350000); assert.equal(f.payerName, "Ada Okoro");
  assert.equal(bank.normalize("flutterwave", { event: "charge.completed", data: { id: 1, status: "successful", amount: 5, payment_type: "card" } }), null);
  assert.equal(bank.normalize("paystack", { event: "charge.success", data: { id: 5, status: "success", amount: 250000, channel: "card" } }), null);
  assert.equal(bank.normalize("generic", { id: "x1", amount: 12500 }).amountKobo, 1250000);
  assert.equal(bank.normalize("generic", {}), null);
});

test("the feed must prove who it is", () => {
  process.env.BANK_WEBHOOK_SECRET = "s3cret";
  assert.equal(bank.verifySignature("generic", { headers: { "x-bank-secret": "s3cret" } }), true);
  assert.equal(bank.verifySignature("generic", { headers: { "x-bank-secret": "nope" } }), false);
  process.env.PAYSTACK_SECRET_KEY = "sk"; const raw = Buffer.from('{"a":1}');
  assert.equal(bank.verifySignature("paystack", { rawBody: raw, headers: { "x-paystack-signature": crypto.createHmac("sha512", "sk").update(raw).digest("hex") } }), true);
  delete process.env.BANK_WEBHOOK_SECRET;
  assert.equal(bank.verifySignature("generic", { headers: { "x-bank-secret": "" } }), false);
});

test("reference in the narration, the only request for that amount, or the payer's name decides; otherwise the admins are asked", async () => {
  request("MAN-AAA", 1500000, "Ada Okoro");
  request("MAN-BBB", 1500000, "Bola Ade");
  const byRef = await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-1", amountKobo: 1500000, narration: "pay man-bbb", payerName: "x" }, null);
  assert.equal(byRef.status, "MATCHED"); assert.equal(byRef.ref, "MAN-BBB");
  assert.equal((await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-1", amountKobo: 1500000 }, null)).duplicate, true);

  request("MAN-CCC", 250000, "Chi Obi");
  assert.equal((await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-2", amountKobo: 250000 }, null)).ref, "MAN-CCC");

  request("MAN-D", 480000, "Ngozi Eze"); request("MAN-E", 480000, "Tunde Bello");
  assert.equal((await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-3", amountKobo: 480000, payerName: "BELLO TUNDE" }, null)).ref, "MAN-E");

  request("MAN-F", 700000, "Amina Musa"); request("MAN-G", 700000, "Segun Ade");
  assert.equal((await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-4", amountKobo: 700000, payerName: "Unknown" }, null)).status, "AMBIGUOUS");
  assert.equal((await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-5", amountKobo: 123400 }, null)).status, "UNMATCHED");
  assert.ok(db.notification.rows.some((n) => /confirmed automatically/.test(n.title)));
  assert.ok(db.notification.rows.some((n) => /without a request/.test(n.title)));

  const kept = db.bankCredit.rows.find((r) => r.providerRef === "GEN-4");
  const f = db.manualPaymentRequest.rows.find((r) => r.reference === "MAN-F");
  assert.equal((await bank.matchByHand(kept.id, f.id, null)).ok, true);
  assert.equal((await bank.matchByHand(kept.id, f.id, null)).reason, "already_matched");
});

test("a payment that is too small for the reference it names is not confirmed", async () => {
  confirmed.length = 0;
  request("MAN-SMALL", 1500000, "Short Payer");
  const r = await bank.processCredit({ provider: "GENERIC", providerRef: "GEN-6", amountKobo: 500000, narration: "man-small", payerName: "Short Payer" }, null);
  assert.notEqual(r.status, "MATCHED");
  assert.equal(confirmed.length, 0);
});
