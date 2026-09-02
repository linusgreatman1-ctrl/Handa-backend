const crypto = require("crypto");
const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");
const orderFlow = require("../services/orderFlow.service");
const walletSvc = require("../services/wallet.service");
const manualPayments = require("../services/manualPayments.service");

// Wallet top-up ("+ Add Funds" on the escrow wallet card).
async function initializeWalletDeposit(req, res, next) {
  try {
    const { amountKobo, paymentMethod } = req.body;
    if (!amountKobo || amountKobo < 10000) return res.status(400).json({ error: "Minimum top-up is ₦100." });

    if (paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails, paid } = await manualPayments.createManualPaymentRequest(req.user.id, "WALLET_DEPOSIT", null, amountKobo, req.app.get("io"));
      if (paid) return res.json({ paid: true });
      return res.json({ manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before funding your wallet." });

    const reference = generateReference("DEP");
    const data = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: { purpose: "WALLET_DEPOSIT", userId: req.user.id },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// Payer-side status poll for a manual bank-transfer request (any purpose)
// — the frontend polls this after "I've Made the Transfer" until an admin
// confirms or rejects it.
async function getManualPaymentRequest(req, res, next) {
  try {
    const request = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "Request not found." });
    res.json({ request });
  } catch (err) {
    next(err);
  }
}

// Dev/testing-only shortcut: the customer's own "I've Made the Transfer"
// tap immediately confirms their own request, instead of needing a real
// admin to click Confirm in the admin panel. Only does anything when
// DEV_BYPASS_PAYMENTS is on (403 otherwise) -- a real bank transfer must
// stay admin-confirmed in production, since nothing here actually
// verifies the money landed. See manualPayments.service.js's
// createManualPaymentRequest for why this moved off the request-creation
// step onto this explicit customer action instead.
async function confirmManualPaymentDev(req, res, next) {
  try {
    if (!walletSvc.devBypassEnabled()) return res.status(403).json({ error: "Dev bypass is not enabled." });
    const request = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "PENDING") return res.json({ request });
    const confirmed = await manualPayments.confirmManualPaymentRequest(request.id, null, req.app.get("io"));
    res.json({ request: confirmed });
  } catch (err) {
    next(err);
  }
}

// Called by the frontend after Paystack's inline checkout closes, and
// independently by the webhook — both paths are idempotent (a Paystack
// reference can only fund one wallet credit / unlock one escrow hold
// because each verify call is gated by the transaction/booking/session's
// own current state, not by "has this reference been seen").
async function verifyPayment(req, res, next) {
  try {
    const { reference } = req.params;
    const data = await paystack.verifyTransaction(reference);
    if (data.status !== "success") {
      return res.status(402).json({ error: "Payment was not successful.", status: data.status });
    }
    const result = await applyVerifiedPayment(data, req.app.get("io"));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// Routes a confirmed Paystack payment to whatever it was actually for,
// based on the metadata.purpose set when the transaction was initialized.
async function applyVerifiedPayment(data, io) {
  const purpose = data.metadata?.purpose;
  if (purpose === "WALLET_DEPOSIT") {
    await wallet.creditWallet(data.metadata.userId, data.amount, "DEPOSIT", { reference: data.reference, description: "Wallet top-up via Paystack" });
    return { purpose };
  }
  if (purpose === "BOOKING_PAYMENT") {
    await orderFlow.confirmBookingPayment(data.metadata.bookingId, data.reference, io);
    return { purpose, bookingId: data.metadata.bookingId };
  }
  if (purpose === "SHOP_SESSION_PAYMENT") {
    await orderFlow.confirmShopSessionPayment(data.metadata.sessionId, data.amount, data.reference, io);
    return { purpose, sessionId: data.metadata.sessionId };
  }
  if (purpose === "SHOP_SESSION_CALL_TOPUP") {
    await orderFlow.confirmCallTopUp(data.metadata.sessionId, data.amount, data.reference);
    return { purpose, sessionId: data.metadata.sessionId };
  }
  if (purpose === "SHOP_SESSION_RIDER_FEE_TOPUP") {
    await orderFlow.confirmRiderFeeTopUp(data.metadata.sessionId, data.amount);
    return { purpose, sessionId: data.metadata.sessionId };
  }
  if (purpose === "SHOP_SESSION_SHORTFALL_PAYMENT") {
    await orderFlow.confirmShopSessionShortfall(data.metadata.sessionId);
    return { purpose, sessionId: data.metadata.sessionId };
  }
  if (purpose === "COMMISSION_PAYMENT") {
    await orderFlow.confirmCommissionPayment(data.metadata.commissionPeriodId, data.reference);
    return { purpose };
  }
  if (purpose === "FEATURE_BOOST_PAYMENT") {
    await orderFlow.confirmFeatureBoostPayment(data.metadata.vendorId, data.amount, data.reference, data.metadata.plan);
    return { purpose };
  }
  return { purpose: purpose || "UNKNOWN" };
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw request body
// using the secret key — verifying this is what stops anyone from POSTing
// a fake "payment succeeded" event straight at this endpoint.
async function webhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const expected = crypto.createHmac("sha512", secret || "").update(req.rawBody || "").digest("hex");
    if (!secret || signature !== expected) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body;
    const eventRef = event?.data?.reference || event?.id?.toString();
    if (!eventRef) return res.status(400).json({ error: "Missing event reference." });

    const already = await prisma.paymentWebhookEvent.findUnique({ where: { eventRef } });
    if (already) return res.json({ received: true, duplicate: true });

    await prisma.paymentWebhookEvent.create({ data: { eventRef, payload: event } });

    if (event.event === "charge.success") {
      await applyVerifiedPayment(event.data, req.app.get("io"));
    } else if (event.event === "transfer.success" || event.event === "transfer.failed" || event.event === "transfer.reversed") {
      await orderFlow.applyTransferWebhook(event, req.app.get("io"));
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

// Commission (10% weekly) and "Get Featured" boost are direct vendor
// payments to the platform, not escrow — separate from order flow.
async function initializeCommissionPayment(req, res, next) {
  try {
    const period = await prisma.commissionPeriod.findUnique({ where: { id: req.params.id } });
    if (!period || period.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Commission period not found." });

    // A period already marked PAID can still accrue MORE due afterward --
    // Event Planner commission (addBookingCommission) increments
    // amountDueKobo every time a booking completes, with no upper bound
    // tied to the period's own status. Gating on the stale `status` field
    // alone permanently blocked paying off that newly-accrued balance
    // until the period rolled over next week, even though a real amount
    // was outstanding. The real, always-correct gate is the actual
    // remaining balance.
    const amountKobo = period.amountDueKobo - period.amountPaidKobo;
    if (amountKobo <= 0) return res.status(409).json({ error: "This commission period is already paid." });
    const reference = generateReference("COM");

    if (req.body.paymentMethod === "WALLET") {
      await walletSvc.debitWallet(req.user.id, amountKobo, "COMMISSION_PAYMENT", {
        reference,
        description: "Commission payment via wallet",
      });
      await orderFlow.confirmCommissionPayment(period.id, reference);
      return res.json({ paid: true });
    }

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails, paid } = await manualPayments.createManualPaymentRequest(req.user.id, "COMMISSION_PAYMENT", period.id, amountKobo, req.app.get("io"));
      if (paid) return res.json({ paid: true });
      return res.json({ manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    const data = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: { purpose: "COMMISSION_PAYMENT", commissionPeriodId: period.id },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// ₦6,500/month or ₦70,000/year — replaces the old flat ₦5,000/week plan.
const FEATURE_BOOST_PRICES_KOBO = { MONTHLY: 650000, YEARLY: 7000000 };

async function initializeFeatureBoostPayment(req, res, next) {
  try {
    const plan = req.body.plan === "YEARLY" ? "YEARLY" : "MONTHLY";
    const amountKobo = FEATURE_BOOST_PRICES_KOBO[plan];
    const reference = generateReference("BST");

    if (req.body.paymentMethod === "WALLET") {
      await walletSvc.debitWallet(req.user.id, amountKobo, "FEATURE_BOOST_PAYMENT", {
        reference,
        description: `Feature boost payment via wallet (${plan.toLowerCase()})`,
      });
      await orderFlow.confirmFeatureBoostPayment(req.user.vendorProfile.id, amountKobo, reference, plan);
      return res.json({ paid: true });
    }

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      // ManualPaymentRequest has no separate metadata column -- the plan is
      // encoded into targetId ("<vendorId>:<plan>") and split back out in
      // manualPayments.service.js's metadataForRequest, same trick used
      // nowhere else in this file only because every other purpose here
      // needs just the one id.
      const { request, bankDetails, paid } = await manualPayments.createManualPaymentRequest(req.user.id, "FEATURE_BOOST_PAYMENT", `${req.user.vendorProfile.id}:${plan}`, amountKobo, req.app.get("io"));
      if (paid) return res.json({ paid: true });
      return res.json({ manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    const data = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: { purpose: "FEATURE_BOOST_PAYMENT", vendorId: req.user.vendorProfile.id, plan },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

module.exports = { initializeWalletDeposit, verifyPayment, webhook, initializeCommissionPayment, initializeFeatureBoostPayment, applyVerifiedPayment, getManualPaymentRequest, confirmManualPaymentDev };
