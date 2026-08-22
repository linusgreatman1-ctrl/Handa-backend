const prisma = require("../config/db");
const wallet = require("./wallet.service");

const AUTO_RELEASE_HOURS = Number(process.env.ESCROW_AUTO_RELEASE_HOURS || 24);

// Platform's cut, taken automatically out of a payout the moment its hold
// releases — a real-time deduction, not a separate weekly invoice.
// VENDOR here covers Booking (home cook / event planner) completions at
// 10%. The older weekly CommissionPeriod debt-invoice system
// (src/services/commission.service.js) always reflects 0 due for bookings
// now, specifically to avoid double-charging a vendor for the same
// booking's commission a second time.
const PLATFORM_COMMISSION_RATES = { SHOPPER: 0.2, RIDER: 0.2, VENDOR: 0.1 };

// Every booking/session is paid into escrow up front (real money already
// collected from the customer via Paystack — see payments.service) and
// only credited to the vendor/rider/shopper's withdrawable Wallet once
// released. One hold per beneficiary so a Shop-For-Me session can release
// the shopper's session fee, the rider's delivery fee, and each market
// seller's payout independently instead of all-or-nothing.
async function createHold({ contextType, bookingId, shopSessionId, payerId, payeeId, payeeRole, amountKobo, autoRelease = true }, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Escrow amount must be positive."), { status: 400 });
  return tx.escrowHold.create({
    data: {
      contextType,
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

// Shared by releaseHold and resolveDisputedHold's RELEASE outcome — credits
// the payee minus the platform's cut, recording that cut as its own
// PLATFORM-role hold. A commission that rounds to 0 kobo (a very small
// hold) intentionally skips creating a zero-amount PLATFORM row rather
// than recording a no-op.
async function creditPayeeWithCommission(tx, hold, { reference, description } = {}) {
  if (!hold.payeeId || hold.payeeRole === "PLATFORM") return;
  const commissionRate = PLATFORM_COMMISSION_RATES[hold.payeeRole] || 0;
  const commissionKobo = Math.round(hold.amountKobo * commissionRate);
  const payoutKobo = hold.amountKobo - commissionKobo;

  await wallet.creditWallet(
    hold.payeeId,
    payoutKobo,
    "PAYOUT",
    { contextType: hold.contextType, contextId: hold.bookingId || hold.shopSessionId, reference, description },
    tx
  );

  if (commissionKobo > 0) {
    await tx.escrowHold.create({
      data: {
        contextType: hold.contextType,
        bookingId: hold.bookingId,
        shopSessionId: hold.shopSessionId,
        payerId: hold.payerId,
        payeeId: null,
        payeeRole: "PLATFORM",
        amountKobo: commissionKobo,
        status: "RELEASED",
        releasedAt: new Date(),
        autoReleaseAt: null,
      },
    });
  }
}

// Releases one hold, crediting the beneficiary's withdrawable wallet.
// PLATFORM holds have no payee wallet — releasing one is just bookkeeping
// (the money was never moved out of the platform's Paystack balance).
// Only ever operates on a still-HELD hold — a DISPUTED one must go through
// resolveDisputedHold instead (an explicit admin decision), never through
// this generic path, so a booking cancellation/delivery-confirm elsewhere
// in the app can never accidentally sweep up a hold mid-dispute.
async function releaseHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    await creditPayeeWithCommission(tx, hold, { reference, description });

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "RELEASED", releasedAt: new Date() } });
  });
}

async function releaseAllHoldsForContext({ contextType, bookingId, shopSessionId }, opts = {}) {
  const holds = await prisma.escrowHold.findMany({
    where: { contextType, bookingId, shopSessionId, status: "HELD" },
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
// Same HELD-only restriction as releaseHold, same reasoning.
async function refundHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    await wallet.creditWallet(
      hold.payerId,
      hold.amountKobo,
      "ESCROW_REFUND",
      { contextType: hold.contextType, contextId: hold.bookingId || hold.shopSessionId, reference, description },
      tx
    );

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "REFUNDED", refundedAt: new Date() } });
  });
}

async function refundAllHoldsForContext({ contextType, bookingId, shopSessionId }, opts = {}) {
  const holds = await prisma.escrowHold.findMany({
    where: { contextType, bookingId, shopSessionId, status: "HELD" },
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

// The only path that can ever move a DISPUTED hold to a terminal state —
// called exclusively from admin dispute resolution (support.controller.js).
// Before this existed, disputeHold() had no inverse: releaseHold/refundHold
// both hard-require HELD, so a disputed hold was stuck forever regardless
// of how the ticket was resolved (money silently never moved even though
// the ticket/booking status looked resolved).
//   outcome "RELEASE" — pays the payee (minus platform commission), same
//     as a normal release. Used when the admin sides with the payee.
//   outcome "REFUND"  — pays the payer back the hold's full amount. Used
//     when the admin sides with the payer and no separate refund credit
//     was already issued elsewhere.
// skipCredit:true closes the hold's status without moving any money —
// for the case where the admin's decided refund amount already reached
// the customer through a separate platform-funded ADJUSTMENT credit (which
// may differ from the held amount — a partial refund), so crediting again
// here would double-pay them.
async function resolveDisputedHold(holdId, outcome, { reference, description, skipCredit } = {}) {
  if (outcome !== "RELEASE" && outcome !== "REFUND") {
    throw Object.assign(new Error(`Unknown dispute resolution outcome "${outcome}".`), { status: 400 });
  }
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "DISPUTED") throw Object.assign(new Error(`Escrow hold is not disputed (currently ${hold.status.toLowerCase()}).`), { status: 409 });

    if (outcome === "RELEASE") {
      if (!skipCredit) await creditPayeeWithCommission(tx, hold, { reference, description });
      return tx.escrowHold.update({ where: { id: holdId }, data: { status: "RELEASED", releasedAt: new Date() } });
    }
    if (!skipCredit) {
      await wallet.creditWallet(
        hold.payerId,
        hold.amountKobo,
        "ESCROW_REFUND",
        { contextType: hold.contextType, contextId: hold.bookingId || hold.shopSessionId, reference, description },
        tx
      );
    }
    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "REFUNDED", refundedAt: new Date() } });
  });
}

async function resolveDisputedHoldsForContext({ contextType, bookingId, shopSessionId }, outcome, opts = {}) {
  const holds = await prisma.escrowHold.findMany({
    where: { contextType, bookingId, shopSessionId, status: "DISPUTED" },
  });
  const resolved = [];
  for (const hold of holds) {
    resolved.push(await resolveDisputedHold(hold.id, outcome, opts));
  }
  return resolved;
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
  resolveDisputedHold,
  resolveDisputedHoldsForContext,
  runAutoReleaseSweep,
};
