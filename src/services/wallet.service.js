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

async function debitWallet(userId, amountKobo, type, { contextType, contextId, reference, description } = {}, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Debit amount must be positive."), { status: 400 });
  const wallet = await getOrCreateWallet(userId, tx);
  if (wallet.balanceKobo < amountKobo) {
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

module.exports = { getOrCreateWallet, creditWallet, debitWallet };
