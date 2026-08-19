// Centralizes what happens the moment a Paystack payment is confirmed
// (via verify-poll or webhook — both call these same functions, so
// whichever arrives first wins and the other is a safe no-op) for each of
// the payable flows: Booking, ShopSession. Kept separate from
// payments.controller so bookings/shopSessions controllers can also
// call these directly for the WALLET payment method, which never touches
// Paystack at all.
const prisma = require("../config/db");
const escrow = require("./escrow.service");
const wallet = require("./wallet.service");

async function confirmBookingPayment(bookingId, reference) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { vendor: true } });
  if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404 });
  if (booking.status !== "ACCEPTED") {
    throw Object.assign(new Error("This booking has not been accepted by the vendor yet."), { status: 409 });
  }

  const existingHold = await prisma.escrowHold.findFirst({ where: { bookingId, payeeRole: "VENDOR" } });
  if (existingHold) return booking;

  await escrow.createHold({
    contextType: "BOOKING",
    bookingId,
    payerId: booking.customerId,
    payeeId: booking.vendor.userId,
    payeeRole: "VENDOR",
    amountKobo: booking.totalKobo,
  });

  return prisma.booking.update({ where: { id: bookingId }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
}

// A ShopSession's deposit covers the session fee (released to the shopper
// once matched) plus a shopping budget later disbursed to market sellers
// via SellerPayout — see shopSessions.controller for that split.
async function confirmShopSessionPayment(sessionId, amountKobo, reference) {
  const session = await prisma.shopSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Object.assign(new Error("Shop session not found."), { status: 404 });

  const updated = await prisma.shopSession.update({ where: { id: sessionId }, data: { depositKobo: { increment: amountKobo } } });
  await ensureShopperFeeHold(updated);
  return updated;
}

// Idempotent: a session's SHOPPER fee hold can only be created once both
// a shopper has been matched AND the deposit covering the fee has landed
// — whichever of those two events happens second is what actually creates
// it, so both confirmShopSessionPayment (payment path) and
// shopSessions.controller.matchSession (matching path) call this.
async function ensureShopperFeeHold(session) {
  if (!session.shopperId || session.depositKobo < session.sessionFeeKobo) return null;
  const existing = await prisma.escrowHold.findFirst({ where: { shopSessionId: session.id, payeeRole: "SHOPPER" } });
  if (existing) return existing;

  const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId } });
  return escrow.createHold({
    contextType: "SHOP_SESSION",
    shopSessionId: session.id,
    payerId: session.customerId,
    payeeId: shopper.userId,
    payeeRole: "SHOPPER",
    amountKobo: session.sessionFeeKobo,
  });
}

async function confirmCommissionPayment(commissionPeriodId, reference) {
  const period = await prisma.commissionPeriod.findUnique({ where: { id: commissionPeriodId } });
  if (!period || period.status === "PAID") return period;
  return prisma.commissionPeriod.update({
    where: { id: commissionPeriodId },
    data: { amountPaidKobo: period.amountDueKobo, status: "PAID", paidAt: new Date() },
  });
}

async function confirmFeatureBoostPayment(vendorId, amountKobo, reference) {
  const endAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.vendorProfile.update({ where: { id: vendorId }, data: { featuredUntil: endAt } });
  return prisma.featureBoost.create({ data: { vendorId, amountPaidKobo: amountKobo, endAt } });
}

// Reconciles Paystack Transfer webhooks (withdrawals + seller payouts) —
// a transfer can fail asynchronously well after we optimistically marked
// it PROCESSING, so the wallet debit only becomes final (or gets reversed)
// here.
async function applyTransferWebhook(event) {
  const transferCode = event.data?.transfer_code;
  if (!transferCode) return;

  const withdrawal = await prisma.withdrawal.findFirst({ where: { paystackTransferCode: transferCode } });
  if (withdrawal) {
    if (event.event === "transfer.success") {
      await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "FAILED", failureReason: event.data?.reason || event.event } });
        await wallet.creditWallet(withdrawal.userId, withdrawal.amountKobo, "ADJUSTMENT", { description: "Withdrawal reversed: transfer failed." }, tx);
      });
    }
    return;
  }

  const payout = await prisma.sellerPayout.findFirst({ where: { reference: transferCode } });
  if (payout) {
    await prisma.sellerPayout.update({
      where: { id: payout.id },
      data: { status: event.event === "transfer.success" ? "PAID" : "FAILED", paidAt: event.event === "transfer.success" ? new Date() : null },
    });
  }
}

module.exports = {
  confirmBookingPayment,
  confirmShopSessionPayment,
  ensureShopperFeeHold,
  confirmCommissionPayment,
  confirmFeatureBoostPayment,
  applyTransferWebhook,
};
