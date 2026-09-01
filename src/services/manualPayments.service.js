const prisma = require("../config/db");
const { generateReference } = require("../utils/reference");
const companyBank = require("../config/companyBank");
const { notifyAllAdmins } = require("./notifications.service");

// Bank Transfer is the one payment method that never touches Paystack —
// every other method (Card/USSD/Wallet) keeps using it unchanged. The
// payer sees these real company bank details, pays outside the app, then
// taps "I've Made the Transfer" (createManualPaymentRequest), and an admin
// confirms it once the money is actually seen to have landed
// (confirmManualPaymentRequest) — see PassNow's own manual-transfer
// pattern, which this mirrors, plus the admin-confirmation step PassNow
// itself never built.
async function createManualPaymentRequest(userId, purpose, targetId, amountKobo, io) {
  const reference = generateReference("MAN");
  const request = await prisma.manualPaymentRequest.create({
    data: { userId, purpose, targetId: targetId != null ? String(targetId) : null, amountKobo, reference },
  });
  // Always starts PENDING, regardless of DEV_BYPASS_PAYMENTS -- the
  // customer must see the real bank details and take the "I've Made the
  // Transfer" action before anything downstream (escrow holds, notifying
  // a matched shopper/rider, etc.) is treated as paid. Confirming
  // immediately here (the old behavior) meant a shopper got notified of a
  // new Shop-For-Me session the instant the customer merely SELECTED
  // Bank Transfer, before they'd done anything resembling paying.
  //
  // The dev-bypass shortcut now lives at the "I've Made the Transfer" tap
  // instead (payments.controller.js's confirmManualPaymentDev, called by
  // the frontend's confirmManualBankTransfer) -- same end result (no
  // second admin session needed to click Confirm during testing), but
  // gated behind an explicit customer action instead of firing before
  // they've done anything.
  if (io) {
    notifyAllAdmins(io, "🏦 New manual bank transfer", `A user submitted a bank transfer for ₦${Math.round(amountKobo / 100).toLocaleString()} — confirm it once received.`, { manualPaymentRequestId: request.id }).catch(() => {});
  }
  return { request, bankDetails: companyBank, paid: false };
}

// Maps a ManualPaymentRequest onto the exact metadata shape
// applyVerifiedPayment (payments.controller.js) already expects from a
// real Paystack event — reusing all of its existing purpose-routing so a
// manual confirmation has identical downstream effects (escrow, booking/
// session status, wallet credit) to a real Paystack payment.
function metadataForRequest(request) {
  const metadata = { purpose: request.purpose, userId: request.userId };
  if (request.purpose === "BOOKING_PAYMENT") metadata.bookingId = request.targetId;
  else if (request.purpose === "SHOP_SESSION_PAYMENT" || request.purpose === "SHOP_SESSION_CALL_TOPUP" || request.purpose === "SHOP_SESSION_RIDER_FEE_TOPUP" || request.purpose === "SHOP_SESSION_SHORTFALL_PAYMENT") metadata.sessionId = request.targetId;
  else if (request.purpose === "COMMISSION_PAYMENT") metadata.commissionPeriodId = request.targetId;
  else if (request.purpose === "FEATURE_BOOST_PAYMENT") {
    // See payments.controller.js's initializeFeatureBoostPayment -- targetId
    // is "<vendorId>:<plan>" since this model has no separate metadata column.
    const [vendorId, plan] = String(request.targetId).split(":");
    metadata.vendorId = vendorId;
    metadata.plan = plan;
  }
  return metadata;
}

async function confirmManualPaymentRequest(requestId, adminUserId, io) {
  const request = await prisma.manualPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request) throw Object.assign(new Error("Manual payment request not found."), { status: 404 });
  if (request.status !== "PENDING") throw Object.assign(new Error(`This request is already ${request.status.toLowerCase()}.`), { status: 409 });

  // Requires payments.controller's applyVerifiedPayment lazily to avoid a
  // require-cycle (payments.controller.js doesn't itself require this
  // service, but keeping this local anyway is cheap insurance).
  const { applyVerifiedPayment } = require("../controllers/payments.controller");
  await applyVerifiedPayment({ reference: request.reference, amount: request.amountKobo, metadata: metadataForRequest(request) }, io);

  return prisma.manualPaymentRequest.update({
    where: { id: request.id },
    data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedByAdminId: adminUserId },
  });
}

async function rejectManualPaymentRequest(requestId, adminUserId) {
  const request = await prisma.manualPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request) throw Object.assign(new Error("Manual payment request not found."), { status: 404 });
  if (request.status !== "PENDING") throw Object.assign(new Error(`This request is already ${request.status.toLowerCase()}.`), { status: 409 });
  return prisma.manualPaymentRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED", confirmedAt: new Date(), confirmedByAdminId: adminUserId },
  });
}

module.exports = { createManualPaymentRequest, confirmManualPaymentRequest, rejectManualPaymentRequest };
