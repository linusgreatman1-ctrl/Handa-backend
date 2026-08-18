const prisma = require("../config/db");
const wallet = require("./wallet.service");

const AUTO_RELEASE_HOURS = Number(process.env.ESCROW_AUTO_RELEASE_HOURS || 24);

// Every order/booking/session is paid into escrow up front (real money
// already collected from the customer via Paystack — see payments.service)
// and only credited to the vendor/rider/shopper's withdrawable Wallet once
// released. One hold per beneficiary so a Shop-For-Me session can release
// the shopper's session fee, the rider's delivery fee, and each market
// seller's payout independently instead of all-or-nothing.
async function createHold({ contextType, orderId, bookingId, shopSessionId, payerId, payeeId, payeeRole, amountKobo, autoRelease = true }, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Escrow amount must be positive."), { status: 400 });
  return tx.escrowHold.create({
    data: {
      contextType,
      orderId,
      bookingId,
      shopSessionId,
      payerId,
      payeeId,
      payeeRole,
      amountKobo,
      autoReleaseAt: autoRelease ? new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000) : null,
    },
  });
}

// Releases one hold, crediting the beneficiary's withdrawable wallet.
// PLATFORM holds have no payee wallet — releasing one is just bookkeeping
// (the money was never moved out of the platform's Paystack balance).
async function releaseHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    if (hold.payeeId && hold.payeeRole !== "PLATFORM") {
      await wallet.creditWallet(
        hold.payeeId,
        hold.amountKobo,
        "PAYOUT",
        { contextType: hold.contextType, contextId: hold.orderId || hold.bookingId || hold.shopSessionId, reference, description },
        tx
      );
    }

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "RELEASED", releasedAt: new Date() } });
  });
}

async function releaseAllHoldsForContext({ contextType, orderId, bookingId, shopSessionId }, opts = {}) {
  const holds = await prisma.escrowHold.findMany({
    where: { contextType, orderId, bookingId, shopSessionId, status: "HELD" },
  });
  const released = [];
  for (const hold of holds) {
    released.push(await releaseHold(hold.id, opts));
  }
  return released;
}

// Cancellations refund the payer as wallet credit (in-app store credit)
// rather than reversing the original Paystack charge — simpler and
// matches how most Nigerian marketplace apps handle order cancellation.
async function refundHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    await wallet.creditWallet(
      hold.payerId,
      hold.amountKobo,
      "ESCROW_REFUND",
      { contextType: hold.contextType, contextId: hold.orderId || hold.bookingId || hold.shopSessionId, reference, description },
      tx
    );

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "REFUNDED", refundedAt: new Date() } });
  });
}

async function refundAllHoldsForContext({ contextType, orderId, bookingId, shopSessionId }, opts = {}) {
  const holds = await prisma.escrowHold.findMany({
    where: { contextType, orderId, bookingId, shopSessionId, status: "HELD" },
  });
  const refunded = [];
  for (const hold of holds) {
    refunded.push(await refundHold(hold.id, opts));
  }
  return refunded;
}

async function disputeHold(holdId) {
  return prisma.escrowHold.update({ where: { id: holdId }, data: { status: "DISPUTED" } });
}

// Called by a scheduled job (see server.js) to release any hold whose
// autoReleaseAt has passed and the customer never explicitly confirmed —
// must be server-side, not a client setTimeout, since a closed browser
// tab must not block a vendor/rider from getting paid.
async function runAutoReleaseSweep() {
  const due = await prisma.escrowHold.findMany({
    where: { status: "HELD", autoReleaseAt: { lte: new Date() } },
  });
  for (const hold of due) {
    await releaseHold(hold.id, { description: "Auto-released after the escrow window elapsed." });
  }
  return due.length;
}

module.exports = {
  createHold,
  releaseHold,
  releaseAllHoldsForContext,
  refundHold,
  refundAllHoldsForContext,
  disputeHold,
  runAutoReleaseSweep,
};
