const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const orderFlow = require("../services/orderFlow.service");
const { generateReference } = require("../utils/reference");
const { generateOtpCode } = require("../utils/otp");

const DEFAULT_RIDER_FEE_KOBO = 40000; // ₦400, matches the order flow's base delivery fee

// Session fee is billed by real live-call duration, not item count —
// 1-30min ₦3,000 / 31-60min ₦5,000 / +₦2,000 per additional 30 minutes
// beyond that. The exact minute of the call isn't known until it ends, so
// this is only ever called once (in startPackaging) after callEndedAt is
// stamped — createSession always starts every session at the minimum
// tier as the up-front deposit estimate.
const MIN_SESSION_FEE_KOBO = 300000; // ₦3,000 — first tier, also the up-front deposit estimate.
function sessionFeeForDuration(minutes) {
  if (minutes <= 30) return 300000;
  if (minutes <= 60) return 500000;
  return 500000 + Math.ceil((minutes - 60) / 30) * 200000;
}

async function createSession(req, res, next) {
  try {
    const { storeId, deliveryAddress, deliveryLat, deliveryLng, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required." });

    const session = await prisma.shopSession.create({
      data: {
        customerId: req.user.id,
        storeId: storeId || null,
        deliveryAddress,
        deliveryLat,
        deliveryLng,
        sessionFeeKobo: MIN_SESSION_FEE_KOBO,
        riderFeeKobo: DEFAULT_RIDER_FEE_KOBO,
        pickupCode: generateOtpCode(),
        deliveryCode: generateOtpCode(),
        items: { create: items.map((i) => ({ text: i.text, addedBy: "CUSTOMER" })) },
      },
      include: { items: true },
    });

    req.app.get("io")?.to("dispatch:shoppers").emit("shop-session:new", { sessionId: session.id });
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
}

async function listSessions(req, res, next) {
  try {
    const { as, status } = req.query;
    let where = { customerId: req.user.id };
    if (as === "shopper") {
      if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
      where = { shopperId: req.user.shopperProfile.id };
    } else if (as === "rider") {
      if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
      where = { riderId: req.user.riderProfile.id };
    } else if (as === "available") {
      if (req.user.riderProfile) {
        // Sessions a shopper has finished packaging and is waiting on a
        // rider for — matches the "dispatch:new-shop-delivery" broadcast
        // riders get when a shopper calls POST /:id/find-rider.
        where = { status: "FINDING_RIDER", riderId: null };
      } else if (req.user.shopperProfile) {
        where = { status: "SEARCHING", shopperId: null };
      } else {
        return res.status(403).json({ error: "No shopper or rider profile found." });
      }
    }
    if (status) where.status = status;

    const sessions = await prisma.shopSession.findMany({
      where,
      include: { items: true, customer: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (as === "rider" || as === "available") {
      sessions.forEach((s) => { s.pickupCode = undefined; s.deliveryCode = undefined; });
    }
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

function assertSessionAccess(req, session) {
  const isCustomer = session.customerId === req.user.id;
  const isShopper = req.user.shopperProfile && session.shopperId === req.user.shopperProfile.id;
  const isRider = req.user.riderProfile && session.riderId === req.user.riderProfile.id;
  if (!isCustomer && !isShopper && !isRider && req.user.role !== "ADMIN") {
    const err = new Error("Shop session not found.");
    err.status = 404;
    throw err;
  }
}

// The rider must be told the handover codes verbally/in-app by the
// shopper (pickup) and customer (delivery) — never read them off their
// own screen.
function isRiderOnlyView(req, session) {
  const isCustomer = session.customerId === req.user.id;
  const isShopper = req.user.shopperProfile && session.shopperId === req.user.shopperProfile.id;
  const isRider = req.user.riderProfile && session.riderId === req.user.riderProfile.id;
  return isRider && !isCustomer && !isShopper;
}

async function getSession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        customer: { select: { name: true, phone: true } },
        shopper: { include: { user: { select: { name: true, phone: true } } } },
        rider: { include: { user: { select: { name: true, phone: true } } } },
        sellerPayouts: { include: { seller: true } },
      },
    });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    assertSessionAccess(req, session);
    if (isRiderOnlyView(req, session)) {
      session.pickupCode = undefined;
      session.deliveryCode = undefined;
    }
    res.json({ session });
  } catch (err) {
    next(err);
  }
}

// ── Shopping list items ──

async function addItem(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    assertSessionAccess(req, session);

    const addedBy = req.user.shopperProfile && session.shopperId === req.user.shopperProfile.id ? "SHOPPER" : "CUSTOMER";
    const item = await prisma.shopSessionItem.create({ data: { sessionId: session.id, text: req.body.text, addedBy } });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:item-added", { sessionId: session.id, item });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
}

// Shopper sets the real market price once they've physically found the
// item — this is what turns a free-text request into something the
// customer can actually approve or reject.
async function priceItem(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const item = await prisma.shopSessionItem.findUnique({ where: { id: req.params.itemId }, include: { session: true } });
    if (!item || item.session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Item not found." });

    const { priceKobo } = req.body;
    if (!priceKobo || priceKobo <= 0) return res.status(400).json({ error: "A valid priceKobo is required." });

    const updated = await prisma.shopSessionItem.update({ where: { id: item.id }, data: { priceKobo } });
    req.app.get("io")?.to(`shop-session:${item.sessionId}`).emit("shop-session:item-priced", { sessionId: item.sessionId, item: updated });
    res.json({ item: updated });
  } catch (err) {
    next(err);
  }
}

async function approveItem(req, res, next) {
  try {
    const item = await prisma.shopSessionItem.findUnique({ where: { id: req.params.itemId }, include: { session: true } });
    if (!item || item.session.customerId !== req.user.id) return res.status(404).json({ error: "Item not found." });
    if (!item.priceKobo) return res.status(400).json({ error: "This item has not been priced by the shopper yet." });

    await prisma.shopSessionItem.update({ where: { id: item.id }, data: { approved: true, approvedAt: new Date() } });
    const approvedTotal = await prisma.shopSessionItem.aggregate({
      where: { sessionId: item.sessionId, approved: true },
      _sum: { priceKobo: true },
    });
    const session = await prisma.shopSession.update({
      where: { id: item.sessionId },
      data: { itemsTotalKobo: approvedTotal._sum.priceKobo || 0 },
    });

    req.app.get("io")?.to(`shop-session:${item.sessionId}`).emit("shop-session:item-approved", { sessionId: item.sessionId, itemId: item.id });
    res.json({ session });
  } catch (err) {
    next(err);
  }
}

async function removeItem(req, res, next) {
  try {
    const item = await prisma.shopSessionItem.findUnique({ where: { id: req.params.itemId }, include: { session: true } });
    if (!item) return res.status(404).json({ error: "Item not found." });
    assertSessionAccess(req, item.session);
    await prisma.shopSessionItem.delete({ where: { id: item.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── Payment ──

async function paySession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });

    const budgetKobo = Math.max(0, parseInt(req.body.budgetKobo) || 0);
    const amountKobo = session.sessionFeeKobo + budgetKobo;

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, amountKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me deposit" }, tx);
      });
      const updated = await orderFlow.confirmShopSessionPayment(session.id, amountKobo);
      return res.json({ session: updated, paid: true });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/transfer/USSD." });
    const reference = generateReference("SHP");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: { purpose: "SHOP_SESSION_PAYMENT", sessionId: session.id },
    });
    res.json({ paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// ── Phase transitions ──

async function matchSession(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "SEARCHING" || session.shopperId) return res.status(409).json({ error: "This session has already been matched." });

    const updated = await prisma.shopSession.update({
      where: { id: session.id },
      data: { status: "MATCHED", shopperId: req.user.shopperProfile.id, matchedAt: new Date() },
    });
    await orderFlow.ensureShopperFeeHold(updated);

    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "MATCHED", shopperId: req.user.shopperProfile.id });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

function transitionHandler(fromStatuses, toStatus, { requireShopper, requireRider, codeField, codeErrorMessage } = {}) {
  return async (req, res, next) => {
    try {
      const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
      if (!session) return res.status(404).json({ error: "Shop session not found." });
      if (requireShopper && (!req.user.shopperProfile || session.shopperId !== req.user.shopperProfile.id)) {
        return res.status(403).json({ error: "You are not the shopper on this session." });
      }
      if (requireRider && (!req.user.riderProfile || session.riderId !== req.user.riderProfile.id)) {
        return res.status(403).json({ error: "You are not the rider on this session." });
      }
      if (!fromStatuses.includes(session.status)) {
        return res.status(409).json({ error: `Session must be in one of [${fromStatuses.join(", ")}] (currently ${session.status}).` });
      }
      if (codeField && session[codeField] && req.body.code !== session[codeField]) {
        return res.status(400).json({ error: codeErrorMessage });
      }

      const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: toStatus } });
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: toStatus });
      res.json({ session: updated });
    } catch (err) {
      next(err);
    }
  };
}

async function startCall(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (!req.user.shopperProfile || session.shopperId !== req.user.shopperProfile.id) {
      return res.status(403).json({ error: "You are not the shopper on this session." });
    }
    if (session.status !== "MATCHED") return res.status(409).json({ error: `Session must be MATCHED (currently ${session.status}).` });

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "LIVE_CALL", callStartedAt: new Date() } });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "LIVE_CALL" });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// The real duration-based fee is only knowable once the call ends — if it
// exceeds the minimum tier already collected up front (see createSession),
// the session stays in LIVE_CALL and the customer must pay the difference
// via POST /:id/pay-call-topup before packaging can begin. A call that
// never exceeds 30 minutes needs no top-up (30min is both the floor tier
// and what was already charged), so this transitions straight through.
async function startPackaging(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (!req.user.shopperProfile || session.shopperId !== req.user.shopperProfile.id) {
      return res.status(403).json({ error: "You are not the shopper on this session." });
    }
    if (session.status !== "LIVE_CALL") return res.status(409).json({ error: `Session must be LIVE_CALL (currently ${session.status}).` });

    const callEndedAt = session.callEndedAt || new Date();
    const durationMinutes = Math.max(1, Math.ceil((callEndedAt - session.callStartedAt) / 60000));
    const realFeeKobo = sessionFeeForDuration(durationMinutes);
    const topUpRequiredKobo = Math.max(0, realFeeKobo - session.sessionFeeKobo);

    if (topUpRequiredKobo > 0) {
      const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { callEndedAt } });
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:call-topup-required", { sessionId: session.id, topUpRequiredKobo });
      return res.json({ session: updated, topUpRequiredKobo });
    }

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "PACKAGING", callEndedAt } });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "PACKAGING" });
    res.json({ session: updated, topUpRequiredKobo: 0 });
  } catch (err) {
    next(err);
  }
}

// Charges exactly what's still owed for the real call duration, computed
// fresh from the persisted callStartedAt/callEndedAt (never trusts a
// client-supplied amount) — mirrors paySession's WALLET-vs-Paystack
// branching exactly. On success the session moves LIVE_CALL → PACKAGING.
async function payCallTopUp(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "LIVE_CALL" || !session.callEndedAt) return res.status(409).json({ error: "No call top-up is currently due." });

    const durationMinutes = Math.max(1, Math.ceil((session.callEndedAt - session.callStartedAt) / 60000));
    const realFeeKobo = sessionFeeForDuration(durationMinutes);
    const topUpKobo = realFeeKobo - session.sessionFeeKobo;
    if (topUpKobo <= 0) return res.status(409).json({ error: "No call top-up is currently due." });

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, topUpKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me call fee top-up" }, tx);
      });
      const updated = await orderFlow.confirmCallTopUp(session.id, topUpKobo);
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "PACKAGING" });
      return res.json({ session: updated, paid: true });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/transfer/USSD." });
    const reference = generateReference("TOPUP");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: topUpKobo,
      reference,
      metadata: { purpose: "SHOP_SESSION_CALL_TOPUP", sessionId: session.id },
    });
    res.json({ paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}
const findRider = (req, res, next) => {
  req.app.get("io")?.to("dispatch:riders").emit("dispatch:new-shop-delivery", { sessionId: req.params.id });
  return transitionHandler(["PACKAGING"], "FINDING_RIDER", { requireShopper: true })(req, res, next);
};

async function acceptDelivery(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "FINDING_RIDER") return res.status(409).json({ error: "This session is not looking for a rider yet." });
    if (session.riderId) return res.status(409).json({ error: "Another rider has already accepted this delivery." });

    const updated = await prisma.shopSession.update({
      where: { id: session.id },
      data: { status: "RIDER_ASSIGNED", riderId: req.user.riderProfile.id },
      include: { items: true, customer: { select: { name: true, phone: true } }, shopper: { include: { user: { select: { name: true, phone: true } } } } },
    });

    if (session.riderFeeKobo > 0) {
      await escrow.createHold({
        contextType: "SHOP_SESSION",
        shopSessionId: session.id,
        payerId: session.customerId,
        payeeId: req.user.id,
        payeeRole: "RIDER",
        amountKobo: session.riderFeeKobo,
      });
    }

    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "RIDER_ASSIGNED" });
    // Never leak the handover codes to the rider's own screen — same rule
    // as getSession/listSessions.
    updated.pickupCode = undefined;
    updated.deliveryCode = undefined;
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

const markOutForDelivery = transitionHandler(["RIDER_ASSIGNED"], "OUT_FOR_DELIVERY", {
  requireRider: true,
  codeField: "pickupCode",
  codeErrorMessage: "Incorrect pickup code. Ask the shopper for the code on their screen.",
});
const markDelivered = transitionHandler(["OUT_FOR_DELIVERY"], "DELIVERED", {
  requireRider: true,
  codeField: "deliveryCode",
  codeErrorMessage: "Incorrect delivery code. Ask the customer for their code.",
});

async function confirmSession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "DELIVERED") return res.status(409).json({ error: "Session has not been marked delivered yet." });

    await escrow.releaseAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "Customer confirmed Shop-For-Me delivery" });
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

async function cancelSession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (["DELIVERED", "COMPLETED", "CANCELLED"].includes(session.status)) return res.status(409).json({ error: `Session is already ${session.status.toLowerCase()}.` });

    await escrow.refundAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "Session cancelled by customer" });
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// Shopper allocates the deposited shopping budget (deposit minus the
// session fee already earmarked for them) across the market sellers they
// bought from, paying each directly by bank transfer.
async function confirmSellerPayouts(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Shop session not found." });

    const { allocations } = req.body; // [{ sellerId, amountKobo, bankCode }]
    if (!Array.isArray(allocations) || allocations.length === 0) return res.status(400).json({ error: "At least one payout allocation is required." });

    const budgetKobo = session.depositKobo - session.sessionFeeKobo;
    const existingPaid = await prisma.sellerPayout.aggregate({
      where: { sessionId: session.id, status: { in: ["PENDING", "PROCESSING", "PAID"] } },
      _sum: { amountKobo: true },
    });
    const requestedTotal = allocations.reduce((sum, a) => sum + a.amountKobo, 0);
    if ((existingPaid._sum.amountKobo || 0) + requestedTotal > budgetKobo) {
      return res.status(400).json({ error: "Payout allocations exceed the deposited shopping budget." });
    }

    const results = [];
    for (const alloc of allocations) {
      const seller = await prisma.registeredSeller.findUnique({ where: { id: alloc.sellerId } });
      if (!seller || seller.shopperId !== req.user.id) {
        results.push({ sellerId: alloc.sellerId, status: "FAILED", error: "Seller not found." });
        continue;
      }
      const reference = generateReference("SLR");
      const payout = await prisma.sellerPayout.create({
        data: { sessionId: session.id, sellerId: seller.id, amountKobo: alloc.amountKobo, reference },
      });
      try {
        const recipient = await paystack.createTransferRecipient({ name: seller.bankAccountName, accountNumber: seller.bankAccountNumber, bankCode: alloc.bankCode });
        const transfer = await paystack.initiateTransfer({ amountKobo: alloc.amountKobo, recipientCode: recipient.recipient_code, reason: "Handa market seller payout", reference });
        await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: "PROCESSING", reference: transfer.transfer_code } });
        results.push({ sellerId: seller.id, status: "PROCESSING" });
      } catch (transferErr) {
        await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: "FAILED" } });
        results.push({ sellerId: seller.id, status: "FAILED", error: transferErr.message });
      }
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  addItem,
  priceItem,
  approveItem,
  removeItem,
  paySession,
  matchSession,
  startCall,
  startPackaging,
  payCallTopUp,
  findRider,
  acceptDelivery,
  markOutForDelivery,
  markDelivered,
  confirmSession,
  cancelSession,
  confirmSellerPayouts,
};
