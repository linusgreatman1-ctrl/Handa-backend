const prisma = require("../config/db");

// All balance mutations go through here so every change is paired with a
// Transaction row — the wallet screens (daily/weekly/monthly earnings,
// "Total Earned / Pending / Withdrawn") are just aggregates over
// Transaction, not a separately-maintained running total that could drift.

async function getOrCreateWallet(userId, tx = prisma) {
  const existing = await tx.wallet.findUnique({ where: { userId } });
  if (existing) return existing;
  return tx.wallet.create({ data: { userId } });
}

async function creditWallet(userId, amountKobo, type, { contextType, contextId, reference, description } = {}, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Credit amount must be positive."), { status: 400 });
  const wallet = await getOrCreateWallet(userId, tx);
  const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balanceKobo: { increment: amountKobo } } });
  await tx.transaction.create({
    data: {
      walletId: wallet.id,
      type,
      amountKobo,
      balanceAfterKobo: updated.balanceKobo,
      contextType,
      contextId,
      reference,
      description,
    },
  });
  return updated;
}

// DEV_BYPASS_PAYMENTS=true lets every "pay by wallet" step across the
// whole app (orders, bookings, shop-sessions) succeed regardless of
// balance — requested explicitly so the full customer→vendor→rider/
// shopper lifecycle can be clicked through end-to-end during development
// without needing real Paystack funds first. The wallet still goes
// negative and every transaction is still logged normally; this only
// removes the block, not the bookkeeping. Unset (or "false") this env
// var before treating the app as production — real customers must never
// be able to spend money they don't have.
function devBypassEnabled() {
  return process.env.DEV_BYPASS_PAYMENTS === "true";
}

async function debitWallet(userId, amountKobo, type, { contextType, contextId, reference, description } = {}, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Debit amount must be positive."), { status: 400 });
  const wallet = await getOrCreateWallet(userId, tx);
  if (wallet.balanceKobo < amountKobo && !devBypassEnabled()) {
    throw Object.assign(new Error("Insufficient wallet balance."), { status: 400 });
  }
  const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balanceKobo: { decrement: amountKobo } } });
  await tx.transaction.create({
    data: {
      walletId: wallet.id,
      type,
      amountKobo: -amountKobo,
      balanceAfterKobo: updated.balanceKobo,
      contextType,
      contextId,
      reference,
      description,
    },
  });
  return updated;
}

module.exports = { getOrCreateWallet, creditWallet, debitWallet, devBypassEnabled };
