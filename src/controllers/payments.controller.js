const crypto = require("crypto");
const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");
const orderFlow = require("../services/orderFlow.service");
const walletSvc = require("../services/wallet.service");

// Wallet top-up ("+ Add Funds" on the escrow wallet card).
async function initializeWalletDeposit(req, res, next) {
  try {
    const { amountKobo } = req.body;
    if (!amountKobo || amountKobo < 10000) return res.status(400).json({ error: "Minimum top-up is ₦100." });
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
    await orderFlow.confirmShopSessionPayment(data.metadata.sessionId, data.amount, data.reference);
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
  if (purpose === "COMMISSION_PAYMENT") {
    await orderFlow.confirmCommissionPayment(data.metadata.commissionPeriodId, data.reference);
    return { purpose };
  }
  if (purpose === "FEATURE_BOOST_PAYMENT") {
    await orderFlow.confirmFeatureBoostPayment(data.metadata.vendorId, data.amount, data.reference);
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
      await orderFlow.applyTransferWebhook(event);
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
    if (period.status === "PAID") return res.status(409).json({ error: "This commission period is already paid." });

    const amountKobo = period.amountDueKobo - period.amountPaidKobo;
    const reference = generateReference("COM");

    if (req.body.paymentMethod === "WALLET") {
      await walletSvc.debitWallet(req.user.id, amountKobo, "COMMISSION_PAYMENT", {
        reference,
        description: "Commission payment via wallet",
      });
      await orderFlow.confirmCommissionPayment(period.id, reference);
      return res.json({ paid: true });
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

async function initializeFeatureBoostPayment(req, res, next) {
  try {
    const weeklyFee = Number(process.env.FEATURE_BOOST_WEEKLY_NGN || 5000) * 100;
    const reference = generateReference("BST");

    if (req.body.paymentMethod === "WALLET") {
      await walletSvc.debitWallet(req.user.id, weeklyFee, "FEATURE_BOOST_PAYMENT", {
        reference,
        description: "Feature boost payment via wallet",
      });
      await orderFlow.confirmFeatureBoostPayment(req.user.vendorProfile.id, weeklyFee, reference);
      return res.json({ paid: true });
    }

    const data = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: weeklyFee,
      reference,
      metadata: { purpose: "FEATURE_BOOST_PAYMENT", vendorId: req.user.vendorProfile.id },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

module.exports = { initializeWalletDeposit, verifyPayment, webhook, initializeCommissionPayment, initializeFeatureBoostPayment };
