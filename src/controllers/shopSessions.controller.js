const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const orderFlow = require("../services/orderFlow.service");
const manualPayments = require("../services/manualPayments.service");
const { generateReference } = require("../utils/reference");
const { generateOtpCode } = require("../utils/otp");
const { notify } = require("../services/notifications.service");
const { closeSupportThreadForContext } = require("./chat.controller");
const distanceFee = require("../utils/distanceFee");

const SEARCHING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
// Split by stage rather than one blanket 2h cutoff for every stage -- a
// customer's dashboard was getting stuck resuming into a dead pre-rider
// session (call/packaging/finding-rider -- nothing here should ever
// legitimately take anywhere near 2 hours) for up to 2 full hours before
// the sweep would clear it. Once a real rider is assigned, genuine
// road-traffic variance still gets a longer allowance.
const STALE_PRE_RIDER_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes — MATCHED/BUILDING_LIST/LIVE_CALL/PACKAGING/FINDING_RIDER
const STALE_POST_RIDER_TIMEOUT_MS = 90 * 60 * 1000; // 90 minutes — RIDER_ASSIGNED/OUT_FOR_DELIVERY

// Off-request-path sweep (same pattern as escrow's auto-release sweep) —
// a SEARCHING session that no shopper ever accepts isn't something any
// single request naturally revisits, so it needs its own periodic check.
// Refunds the customer's deposit and cancels the session so they know to
// search again, rather than leaving it silently stuck forever.
async function expireStaleSearchingSessions(io) {
  const cutoff = new Date(Date.now() - SEARCHING_TIMEOUT_MS);
  const stale = await prisma.shopSession.findMany({
    where: { status: "SEARCHING", shopperId: null, createdAt: { lte: cutoff } },
  });
  for (const session of stale) {
    await escrow.refundAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "No shopper accepted within 30 minutes — auto-cancelled and refunded." });
    await prisma.shopSession.update({ where: { id: session.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    io?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "CANCELLED" });
    io?.to("dispatch:shoppers").emit("shop-session:taken", { sessionId: session.id });
    await notify(io, session.customerId, "ORDER_UPDATE", "Session expired", "No shopper accepted your Shop-For-Me request within 30 minutes. You've been refunded — please search again.", { sessionId: session.id });
    closeSupportThreadForContext(session.id);
  }
  return stale.length;
}

// A session a shopper HAS accepted can still get stuck -- the video call
// never completes, someone's connection drops, a tab gets closed -- with
// nothing else in this codebase ever revisiting it (no other sweep covers
// MATCHED/BUILDING_LIST/LIVE_CALL/PACKAGING/FINDING_RIDER/RIDER_ASSIGNED/
// OUT_FOR_DELIVERY). Refunds and cancels it the same way
// expireStaleSearchingSessions does, but stamps abandonedAt so History can
// show a plain "Uncompleted Session" with no details instead of a normal
// cancelled display -- there's nothing real to show (no completed items,
// no delivery) for a session that never got anywhere.
//
// Originally only covered MATCHED/BUILDING_LIST/LIVE_CALL -- a session
// that got as far as RIDER_ASSIGNED or OUT_FOR_DELIVERY and then genuinely
// stalled (rider never delivers, app closed mid-delivery) had no sweep
// covering it at all, so it stayed "active" forever. restoreActiveShopSession
// (public/app/index.html) treats any of these statuses as "resume into
// it" on every future login -- with no sweep ever clearing a truly-stuck
// one, that customer got permanently routed back into a dead session's
// screen (e.g. stuck on the delivery-tracking screen) every time they
// logged in, with no way out. refundAllHoldsForContext only touches
// still-HELD holds, so this is safe to run at any of these stages --
// anything already released/paid out (e.g. seller payouts) is untouched.
async function expireStaleLiveSessions(io) {
  const preRiderCutoff = new Date(Date.now() - STALE_PRE_RIDER_TIMEOUT_MS);
  const postRiderCutoff = new Date(Date.now() - STALE_POST_RIDER_TIMEOUT_MS);
  const stale = await prisma.shopSession.findMany({
    where: {
      OR: [
        { status: { in: ["MATCHED", "BUILDING_LIST", "LIVE_CALL", "PACKAGING", "FINDING_RIDER"] }, matchedAt: { lte: preRiderCutoff } },
        { status: { in: ["RIDER_ASSIGNED", "OUT_FOR_DELIVERY"] }, matchedAt: { lte: postRiderCutoff } },
      ],
    },
  });
  for (const session of stale) {
    await escrow.refundAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "Session never completed — auto-cancelled and refunded." });
    const now = new Date();
    await prisma.shopSession.update({ where: { id: session.id }, data: { status: "CANCELLED", cancelledAt: now, abandonedAt: now } });
    io?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "CANCELLED" });
    await notify(io, session.customerId, "ORDER_UPDATE", "Session ended", "Your Shop-For-Me session didn't complete in time and has been cancelled. You've been refunded.", { sessionId: session.id });
    if (session.shopperId) {
      const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
      if (shopper) await notify(io, shopper.userId, "ORDER_UPDATE", "Session ended", "A Shop-For-Me session you were on didn't complete in time and has been cancelled.", { sessionId: session.id });
    }
    closeSupportThreadForContext(session.id);
  }
  return stale.length;
}

// ₦4,000 predicted rider fee, collected upfront alongside the ₦3,000
// minimum-tier session fee -- see findRider (refunds the unused portion
// once the real distance-based fee is known) and riderArrivedShopper
// (the combined insufficient-funds check, if the real fee came in over).
const DEFAULT_RIDER_FEE_KOBO = 400000;

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
        // Snapshot of what's actually being collected for each fee at
        // deposit time -- see the schema comment on these two fields.
        sessionFeeCollectedKobo: MIN_SESSION_FEE_KOBO,
        riderFeeCollectedKobo: DEFAULT_RIDER_FEE_KOBO,
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
      // shopper is only ever populated for the rider's own as=available
      // list (FINDING_RIDER sessions already have a shopperId) -- lets the
      // rider see where they'd actually be picking up from before
      // accepting, not just the customer's drop-off address.
      include: { items: true, customer: { select: { name: true, phone: true } }, shopper: { select: { market: true, user: { select: { name: true, address: true, state: true, lga: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    if (as === "rider" || as === "available") {
      sessions.forEach((s) => { s.pickupCode = undefined; s.deliveryCode = undefined; });
    }
    // Same honest approximation tier as the rider-fee estimate (no Maps key
    // configured) -- gives the rider a real distance/ETA to the shopper
    // before deciding to accept, instead of nothing at all.
    if (as === "available" && req.user.riderProfile) {
      // req.user (from requireAuth) doesn't carry state/lga -- a small
      // separate lookup rather than widening that shared middleware's
      // select for every request app-wide just for this one screen.
      const riderUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { state: true, lga: true } });
      const riderPickup = { state: riderUser?.state, lga: riderUser?.lga };
      sessions.forEach((s) => {
        if (!s.shopper?.user) return;
        const km = distanceFee.computeDistanceKm(riderPickup, { state: s.shopper.user.state, lga: s.shopper.user.lga });
        s.distanceToShopperKm = Math.round(km * 10) / 10;
        s.etaToShopperMinutes = Math.max(3, Math.round((km / 25) * 60)); // ~25km/h average urban speed, documented estimate
      });
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
        // id included on all three so the frontend's real chat buttons
        // (customer<->shopper, shopper<->rider, rider<->customer) have a
        // real otherUserId to open a thread with, not just a display name.
        customer: { select: { id: true, name: true, phone: true } },
        shopper: { include: { user: { select: { id: true, name: true, phone: true } } } },
        rider: { include: { user: { select: { id: true, name: true, phone: true } } } },
        sellerPayouts: { include: { seller: true } },
        // Lets the frontend's 'done' screen know if the customer already
        // rated the shopper/rider on THIS session, so it can hide that
        // rating form and show the given score instead of re-offering it.
        ratings: true,
      },
    });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    assertSessionAccess(req, session);
    if (isRiderOnlyView(req, session)) {
      session.pickupCode = undefined;
      session.deliveryCode = undefined;
    }
    // Same "already reported, swap the button for a static state" pattern
    // getBooking already has -- split per role (submitReport's own
    // context map sends 'shopper_session' reports as context:SHOP_SESSION
    // and 'rider' reports as context:RIDER, both keyed by this session's
    // id), so the two report buttons can independently show "already
    // reported" instead of one ticket silently covering both.
    const [shopperReportTicket, riderReportTicket] = await Promise.all([
      prisma.supportTicket.findFirst({ where: { context: "SHOP_SESSION", contextId: session.id }, orderBy: { createdAt: "desc" } }),
      prisma.supportTicket.findFirst({ where: { context: "RIDER", contextId: session.id }, orderBy: { createdAt: "desc" } }),
    ]);
    res.json({ session, shopperReportTicket, riderReportTicket });
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

    // The deposit must cover items + the shopper fee + the rider fee
    // together — approving an item that would push the items total past
    // what's actually left over is refused outright rather than silently
    // allowed, matching the same "stays pending until funded" principle as
    // the call-duration and rider-fee top-ups.
    const currentApproved = await prisma.shopSessionItem.aggregate({
      where: { sessionId: item.sessionId, approved: true },
      _sum: { priceKobo: true },
    });
    const projectedItemsTotal = (currentApproved._sum.priceKobo || 0) + item.priceKobo;
    const availableForItems = item.session.depositKobo - item.session.sessionFeeKobo - item.session.riderFeeKobo;
    if (projectedItemsTotal > availableForItems) {
      return res.status(400).json({
        error: "Your escrow balance is not enough to cover this item alongside the shopper and rider fees. Please top up your escrow to continue.",
        shortfallKobo: projectedItemsTotal - availableForItems,
      });
    }

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
    req.app.get("io")?.to(`shop-session:${item.sessionId}`).emit("shop-session:item-removed", { sessionId: item.sessionId, itemId: item.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// The customer, non-destructively, sends a priced-or-approved item BACK to
// the shopper for re-pricing -- clears priceKobo and approved, keeps the
// item itself. Covers two distinct UI actions with the same real outcome:
// "Reject" (an unapproved-but-priced item wasn't right) and "Disapprove"
// (an already-approved item is being reconsidered) -- both just mean "this
// item needs a new price," repeatable as many times as the customer likes,
// unlike removeItem which is a permanent delete.
async function resetItemPricing(req, res, next) {
  try {
    const item = await prisma.shopSessionItem.findUnique({ where: { id: req.params.itemId }, include: { session: true } });
    if (!item || item.session.customerId !== req.user.id) return res.status(404).json({ error: "Item not found." });
    const updated = await prisma.shopSessionItem.update({ where: { id: item.id }, data: { priceKobo: null, approved: false, approvedAt: null } });
    // Approving this item may have contributed to itemsTotalKobo -- recompute
    // it now that it no longer counts, so the running total shown elsewhere
    // stays accurate immediately rather than only after the next approval.
    const approvedTotal = await prisma.shopSessionItem.aggregate({
      where: { sessionId: item.sessionId, approved: true },
      _sum: { priceKobo: true },
    });
    await prisma.shopSession.update({ where: { id: item.sessionId }, data: { itemsTotalKobo: approvedTotal._sum.priceKobo || 0 } });
    req.app.get("io")?.to(`shop-session:${item.sessionId}`).emit("shop-session:item-reset", { sessionId: item.sessionId, item: updated });
    res.json({ item: updated });
  } catch (err) {
    next(err);
  }
}

// Lets the customer add a brand-new item mid-call -- addItem() above
// already has no phase gate and works fine for this, this is just a
// clearer, purpose-named entry point for the frontend's mid-call "+ Add
// Item" action so it isn't confused with the pre-call bulk-create path.
async function addItemMidCall(req, res, next) {
  return addItem(req, res, next);
}

// The insufficient-funds error from approveItem carries a shortfallKobo —
// this is what actually pays it off, mirroring payCallTopUp/
// payRiderFeeTopUp's exact WALLET-vs-Paystack-vs-BankTransfer branching.
// Unlike those two, no fresh escrow hold is minted here (see
// orderFlow.confirmItemsTopUp's comment) -- the items portion of a deposit
// is just spendable balance, not a per-item hold.
async function topUpItems(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });

    const amountKobo = Math.max(0, parseInt(req.body.amountKobo) || 0);
    if (amountKobo <= 0) return res.status(400).json({ error: "A valid amountKobo is required." });

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, amountKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me items budget top-up" }, tx);
      });
      const updated = await orderFlow.confirmItemsTopUp(session.id, amountKobo);
      return res.json({ session: updated, paid: true });
    }

    // Reuses the SHOP_SESSION_PAYMENT purpose deliberately -- once verified,
    // applyVerifiedPayment routes it to orderFlow.confirmShopSessionPayment,
    // which does exactly the increment-deposit-and-ensure-holds work this
    // top-up needs (ensureShopperFeeHold is idempotent, so re-running it
    // here is a harmless no-op). No new purpose/route needed.
    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails } = await manualPayments.createManualPaymentRequest(req.user.id, "SHOP_SESSION_PAYMENT", session.id, amountKobo, req.app.get("io"));
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
    const reference = generateReference("ITOP");
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

// ── Payment ──

async function paySession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });

    const budgetKobo = Math.max(0, parseInt(req.body.budgetKobo) || 0);
    // Collect for the shopper fee AND the rider fee up front (the fixed
    // estimate set at createSession — findRider later recomputes a real
    // distance-based fee and, if it's higher, blocks on a top-up rather
    // than silently under-collecting), plus whatever items budget the
    // customer sets.
    const amountKobo = session.sessionFeeKobo + session.riderFeeKobo + budgetKobo;

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, amountKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me deposit" }, tx);
      });
      const updated = await orderFlow.confirmShopSessionPayment(session.id, amountKobo);
      return res.json({ session: updated, paid: true });
    }

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails } = await manualPayments.createManualPaymentRequest(req.user.id, "SHOP_SESSION_PAYMENT", session.id, amountKobo, req.app.get("io"));
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
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
    // Every other online shopper was also shown this session as available
    // — tell them it's gone so it doesn't sit in their list implying they
    // could still accept it.
    req.app.get("io")?.to("dispatch:shoppers").emit("shop-session:taken", { sessionId: session.id });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

function transitionHandler(fromStatuses, toStatus, { requireShopper, requireRider, codeField, codeErrorMessage, requireConfirmCall, onSuccess } = {}) {
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
      if (requireConfirmCall && !session.confirmCallCompletedAt) {
        return res.status(409).json({ error: "Complete the 3-way confirm call with the shopper and customer first." });
      }

      const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: toStatus } });
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: toStatus });
      if (onSuccess) {
        try {
          await onSuccess(updated, req);
        } catch (e) {
          console.error("[shop-session] transition onSuccess failed:", e);
        }
      }
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

// The shopper (only shopper leaving pauses it -- see the schema comment on
// callPausedAt) exiting the live call stops the billed-duration clock;
// rejoining resumes it. The customer's own exit/rejoin never touches this
// -- called only from the frontend's shopper-side soft-exit/rejoin, never
// the customer's.
async function pauseCall(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "LIVE_CALL" || session.callPausedAt) return res.json({ session });
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { callPausedAt: new Date() } });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}
async function resumeCall(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Shop session not found." });
    if (!session.callPausedAt) return res.json({ session });
    const pausedMs = Date.now() - session.callPausedAt.getTime();
    const updated = await prisma.shopSession.update({
      where: { id: session.id },
      data: { callPausedAt: null, callPausedTotalMs: { increment: Math.max(0, pausedMs) } },
    });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// The real duration-based fee is only knowable once the call ends. Rather
// than blocking here until the customer pays any difference (the old
// behavior), the real fee is just recorded and the call always proceeds
// straight to packaging -- any shortfall against what's actually been
// collected (sessionFeeCollectedKobo) is caught once, combined with any
// rider-fee shortfall too, by the single insufficient-funds check at
// riderArrivedShopper below.
async function startPackaging(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (!req.user.shopperProfile || session.shopperId !== req.user.shopperProfile.id) {
      return res.status(403).json({ error: "You are not the shopper on this session." });
    }
    if (session.status !== "LIVE_CALL") return res.status(409).json({ error: `Session must be LIVE_CALL (currently ${session.status}).` });

    // The frontend already disables the shopper's "end call" button until
    // every item is approved -- this is the server-side twin of that rule
    // (defense in depth, since the frontend check alone can be bypassed by
    // calling the API directly). The emergency-end path below is the one
    // deliberate exception -- it exists precisely for abnormal
    // circumstances where not everything gets approved.
    const unresolvedCount = await prisma.shopSessionItem.count({ where: { sessionId: session.id, approved: false } });
    if (unresolvedCount > 0) {
      return res.status(400).json({ error: `${unresolvedCount} item(s) still need approval before the call can end.` });
    }

    const callEndedAt = session.callEndedAt || new Date();
    const pausedMs = session.callPausedTotalMs + (session.callPausedAt ? Date.now() - session.callPausedAt.getTime() : 0);
    // TEMP TEST OVERRIDE (revert before finishing): 1000 instead of 60000 so
    // real seconds stand in for "minutes" to live-test the >30min tier
    // without waiting 30 real minutes. MUST be reverted to 60000.
    const durationMinutes = Math.max(1, Math.ceil(((callEndedAt - session.callStartedAt) - pausedMs) / 1000));
    const realFeeKobo = sessionFeeForDuration(durationMinutes);

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "PACKAGING", callEndedAt, sessionFeeKobo: realFeeKobo } });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "PACKAGING" });
    res.json({ session: updated });
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

    const pausedMs = session.callPausedTotalMs + (session.callPausedAt ? Date.now() - session.callPausedAt.getTime() : 0);
    const durationMinutes = Math.max(1, Math.ceil(((session.callEndedAt - session.callStartedAt) - pausedMs) / 60000));
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

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails } = await manualPayments.createManualPaymentRequest(req.user.id, "SHOP_SESSION_CALL_TOPUP", session.id, topUpKobo, req.app.get("io"));
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
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

// Shopper-only, and the ONLY way a call can end before every item is
// approved (startPackaging above hard-requires full approval otherwise).
// attributedTo decides who's charged:
//   'CUSTOMER' — the customer wanted out. They're charged the normal
//     duration-based call fee (same tiers as a real completion, computed
//     fresh from callStartedAt/callPausedTotalMs, capped at whatever was
//     already collected as sessionFeeKobo -- an early end never bills MORE
//     than what's already on deposit), the usual 20% platform commission
//     still applies to that charge (releaseHold already does this for any
//     SHOPPER-role hold), and everything else outstanding is refunded.
//   'SHOPPER' — the shopper needs out. The customer is charged nothing at
//     all; the full deposit is refunded.
// Either way the session becomes CANCELLED/abandoned (same "Uncompleted
// Session" History treatment as the stale-session sweep) and both sides
// get pushed straight back to their home screen.
// Step 1 of 2 -- the shopper's request alone never charges/refunds/ends
// anything. It just flags the session as awaiting the CUSTOMER's own
// Yes/No answer (see confirmEmergencyEnd below, which is where the real
// charge/refund/CANCELLED logic actually lives) and pushes a real prompt
// to the customer's screen. The session stays LIVE_CALL until they answer.
async function requestEmergencyEnd(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "LIVE_CALL") return res.status(409).json({ error: `Session must be LIVE_CALL (currently ${session.status}).` });
    if (session.emergencyEndPendingBy) return res.status(409).json({ error: "An emergency-end request is already awaiting the customer's response." });

    const attributedTo = req.body.attributedTo;
    if (!["CUSTOMER", "SHOPPER"].includes(attributedTo)) return res.status(400).json({ error: "attributedTo must be CUSTOMER or SHOPPER." });

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { emergencyEndPendingBy: attributedTo } });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:emergency-end-requested", { sessionId: session.id, attributedTo });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// Step 2 of 2 -- customer-only. { confirm:true } actually executes the
// charge/refund/CANCELLED logic (moved here verbatim from the old
// single-step emergencyEndCall); { confirm:false } just clears the pending
// flag and leaves the session exactly as it was -- nothing was ever torn
// down or charged while merely "pending", so declining is a true no-op on
// the money/session side, only the UI needs to resume.
async function confirmEmergencyEnd(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (!session.emergencyEndPendingBy) return res.status(409).json({ error: "No emergency-end request is awaiting your response." });

    const attributedTo = session.emergencyEndPendingBy;
    const io = req.app.get("io");

    if (!req.body.confirm) {
      const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { emergencyEndPendingBy: null } });
      io?.to(`shop-session:${session.id}`).emit("shop-session:emergency-end-declined", { sessionId: session.id });
      return res.json({ session: updated });
    }

    if (attributedTo === "CUSTOMER") {
      const now = Date.now();
      const pausedMs = session.callPausedTotalMs + (session.callPausedAt ? now - session.callPausedAt.getTime() : 0);
      const durationMinutes = Math.max(1, Math.ceil((now - session.callStartedAt.getTime() - pausedMs) / 60000));
      const chargeableKobo = Math.min(sessionFeeForDuration(durationMinutes), session.sessionFeeKobo);

      const shopperHolds = await prisma.escrowHold.findMany({ where: { shopSessionId: session.id, payeeRole: "SHOPPER", status: "HELD" } });
      let releasedSoFar = 0;
      for (const hold of shopperHolds) {
        if (releasedSoFar < chargeableKobo) {
          await escrow.releaseHold(hold.id, { description: "Emergency call end -- customer charged for time spent (20% platform commission applies)." });
          releasedSoFar += hold.amountKobo;
        } else {
          await escrow.refundHold(hold.id, { description: "Emergency call end -- unused portion of the call fee refunded." });
        }
      }
    }

    // Refunds whatever's still HELD (all of it for a SHOPPER-attributed end;
    // just the leftover RIDER/other holds for a CUSTOMER-attributed one,
    // since the SHOPPER holds were already resolved above).
    await escrow.refundAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: `Emergency call end (attributed to ${attributedTo === "CUSTOMER" ? "customer" : "shopper"}).` });

    // The items/shopping-budget portion of the deposit was never turned
    // into an EscrowHold in the first place (see topUpItems' comment), and
    // riderFeeKobo has no hold yet either at LIVE_CALL stage (a rider isn't
    // matched until much later) -- both need refunding directly as wallet
    // credit rather than via a hold that doesn't exist, in both branches.
    const shoppingBudgetKobo = Math.max(0, session.depositKobo - session.sessionFeeKobo - session.riderFeeKobo);
    if (shoppingBudgetKobo > 0) {
      await walletSvc.creditWallet(session.customerId, shoppingBudgetKobo, "ESCROW_REFUND", { contextType: "SHOP_SESSION", contextId: session.id, description: "Emergency call end -- unused shopping budget refunded." });
    }

    const now = new Date();
    const updated = await prisma.shopSession.update({
      where: { id: session.id },
      data: { status: "CANCELLED", cancelledAt: now, abandonedAt: now, callEndedAt: session.callEndedAt || now, emergencyEndedBy: attributedTo, emergencyEndPendingBy: null },
    });

    io?.to(`shop-session:${session.id}`).emit("shop-session:emergency-ended", { sessionId: session.id, attributedTo });
    const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
    const custMsg = attributedTo === "CUSTOMER"
      ? "Your shopping session was ended early. You were charged for the time spent on the call; everything else was refunded."
      : "Your shopping session was ended early by your shopper. You were not charged anything -- your full deposit was refunded.";
    await notify(io, session.customerId, "ORDER_UPDATE", "Session ended", custMsg, { sessionId: session.id });
    if (shopper) await notify(io, shopper.userId, "ORDER_UPDATE", "Session ended", "This shopping session was ended early via the emergency-end action.", { sessionId: session.id });
    closeSupportThreadForContext(session.id);

    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// The rider fee is computed right here — "immediately the shopper starts
// searching for a rider" — using the shopper's and customer's registered
// state/LGA (see utils/distanceFee.js for how, given no Maps API key is
// configured yet). Riders then see this real number on GET
// /shop-sessions?as=available before deciding to accept. The predicted
// ₦4,000 collected at deposit time (DEFAULT_RIDER_FEE_KOBO) was only ever
// an estimate: if the real fee comes in UNDER that, the unused portion is
// refunded -- but startPackaging (called earlier, LIVE_CALL->PACKAGING)
// already knows by now whether the real call-duration session fee came in
// OVER what was collected for it. Rather than refunding the rider-fee
// surplus outright while a session-fee shortfall sits unpaid right next
// to it, that surplus is applied to the shortfall FIRST -- only whatever
// is genuinely left over after that gets refunded to the wallet, and only
// whatever the offset didn't cover shows up in the combined
// insufficient-funds check at riderArrivedShopper below.
async function findRider(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({
      where: { id: req.params.id },
      include: {
        shopper: { include: { user: { select: { state: true, lga: true } } } },
        customer: { select: { state: true, lga: true } },
      },
    });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (!req.user.shopperProfile || session.shopperId !== req.user.shopperProfile.id) {
      return res.status(403).json({ error: "You are not the shopper on this session." });
    }
    if (session.status !== "PACKAGING") {
      return res.status(409).json({ error: `Session must be in one of [PACKAGING] (currently ${session.status}).` });
    }

    const pickup = session.shopper?.user || {};
    const dropoff = session.customer || {};
    const { feeKobo, distanceKm } = distanceFee.estimateRiderFeeKobo(pickup, dropoff);
    const riderCollectedKobo = session.riderFeeCollectedKobo ?? session.riderFeeKobo;
    const sessionCollectedKobo = session.sessionFeeCollectedKobo ?? session.sessionFeeKobo;
    const updateData = { status: "FINDING_RIDER", riderFeeKobo: feeKobo };

    const riderSurplusKobo = Math.max(0, riderCollectedKobo - feeKobo);
    if (riderSurplusKobo > 0) {
      const sessionShortfallKobo = Math.max(0, session.sessionFeeKobo - sessionCollectedKobo);
      const offsetKobo = Math.min(riderSurplusKobo, sessionShortfallKobo);
      const refundKobo = riderSurplusKobo - offsetKobo;

      // Whatever of the rider-fee surplus wasn't needed to cover the
      // session-fee side is what's actually left "collected" for the
      // rider fee going forward.
      updateData.riderFeeCollectedKobo = feeKobo + refundKobo;
      if (offsetKobo > 0) updateData.sessionFeeCollectedKobo = sessionCollectedKobo + offsetKobo;

      const io = req.app.get("io");
      if (refundKobo > 0) {
        await walletSvc.creditWallet(session.customerId, refundKobo, "ESCROW_REFUND", { contextType: "SHOP_SESSION", contextId: session.id, description: "Unused portion of the predicted rider delivery fee refunded." });
      }
      if (offsetKobo > 0) {
        const remainingShortfallKobo = sessionShortfallKobo - offsetKobo;
        const msg = remainingShortfallKobo > 0
          ? `Your rider is only ${distanceKm}km away — ₦${Math.round(offsetKobo / 100).toLocaleString()} of the unused delivery fee covered part of your higher call fee. You still owe ₦${Math.round(remainingShortfallKobo / 100).toLocaleString()} more to complete this session.`
          : `Your rider is only ${distanceKm}km away — ₦${Math.round(offsetKobo / 100).toLocaleString()} of the unused delivery fee was applied to cover your higher call fee in full.` + (refundKobo > 0 ? ` The remaining ₦${Math.round(refundKobo / 100).toLocaleString()} was refunded to your wallet.` : "");
        await notify(io, session.customerId, "ORDER_UPDATE", "Delivery fee applied to session fee", msg, { sessionId: session.id });
      } else if (refundKobo > 0) {
        await notify(io, session.customerId, "ORDER_UPDATE", "Delivery fee refunded", `Your rider is only ${distanceKm}km away — ₦${Math.round(refundKobo / 100).toLocaleString()} of the predicted delivery fee was refunded to your wallet.`, { sessionId: session.id });
      }
    }

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: updateData });
    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "FINDING_RIDER" });
    req.app.get("io")?.to("dispatch:riders").emit("dispatch:new-shop-delivery", { sessionId: req.params.id });
    res.json({ session: updated, distanceKm });
  } catch (err) {
    next(err);
  }
}

// Charges exactly the rider-fee shortfall flagged by findRider, computed
// fresh (never trusts a client-supplied amount) — mirrors payCallTopUp's
// WALLET-vs-Paystack branching exactly. On success the session moves
// PACKAGING -> FINDING_RIDER for real.
async function payRiderFeeTopUp(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({
      where: { id: req.params.id },
      include: {
        shopper: { include: { user: { select: { state: true, lga: true } } } },
        customer: { select: { state: true, lga: true } },
      },
    });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "PACKAGING") return res.status(409).json({ error: "No rider-fee top-up is currently due." });

    const pickup = session.shopper?.user || {};
    const dropoff = session.customer || {};
    const { feeKobo } = distanceFee.estimateRiderFeeKobo(pickup, dropoff);
    const topUpKobo = feeKobo - session.riderFeeKobo;
    if (topUpKobo <= 0) return res.status(409).json({ error: "No rider-fee top-up is currently due." });

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, topUpKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me rider fee top-up" }, tx);
      });
      const updated = await orderFlow.confirmRiderFeeTopUp(session.id, topUpKobo);
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:status", { sessionId: session.id, status: "FINDING_RIDER" });
      req.app.get("io")?.to("dispatch:riders").emit("dispatch:new-shop-delivery", { sessionId: req.params.id });
      return res.json({ session: updated, paid: true });
    }

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails } = await manualPayments.createManualPaymentRequest(req.user.id, "SHOP_SESSION_RIDER_FEE_TOPUP", session.id, topUpKobo, req.app.get("io"));
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
    const reference = generateReference("TOPUP");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: topUpKobo,
      reference,
      metadata: { purpose: "SHOP_SESSION_RIDER_FEE_TOPUP", sessionId: session.id },
    });
    res.json({ paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// The single combined insufficient-funds payment -- charges exactly
// whatever's still owed across the session fee and rider fee together,
// computed fresh (never trusts a client-supplied amount), same
// WALLET-vs-Paystack-vs-BankTransfer branching every other top-up here
// uses. Unlike payCallTopUp/payRiderFeeTopUp, this doesn't unblock a
// stuck status transition -- it's only ever due once riderArrivedShopper
// has already flagged it, well after the session moved past PACKAGING/
// FINDING_RIDER on its own, so nothing here changes session.status.
async function payShopSessionShortfall(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });

    const sessionFeeCollectedKobo = session.sessionFeeCollectedKobo ?? session.sessionFeeKobo;
    const riderFeeCollectedKobo = session.riderFeeCollectedKobo ?? session.riderFeeKobo;
    const sessionShortfallKobo = Math.max(0, session.sessionFeeKobo - sessionFeeCollectedKobo);
    const riderShortfallKobo = Math.max(0, session.riderFeeKobo - riderFeeCollectedKobo);
    const totalKobo = sessionShortfallKobo + riderShortfallKobo;
    if (totalKobo <= 0) return res.status(409).json({ error: "No payment is currently due." });

    if (req.body.paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, totalKobo, "ESCROW_HOLD", { contextType: "SHOP_SESSION", contextId: session.id, description: "Shop-For-Me insufficient-funds top-up" }, tx);
      });
      const updated = await orderFlow.confirmShopSessionShortfall(session.id);
      req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:insufficient-funds-resolved", { sessionId: session.id });
      return res.json({ session: updated, paid: true });
    }

    if (req.body.paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails } = await manualPayments.createManualPaymentRequest(req.user.id, "SHOP_SESSION_SHORTFALL_PAYMENT", session.id, totalKobo, req.app.get("io"));
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
    const reference = generateReference("SHORT");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: totalKobo,
      reference,
      metadata: { purpose: "SHOP_SESSION_SHORTFALL_PAYMENT", sessionId: session.id },
    });
    res.json({ paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

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
      include: { items: true, customer: { select: { id: true, name: true, phone: true } }, shopper: { include: { user: { select: { id: true, name: true, phone: true } } } } },
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

// Gated on the 3-way confirm call: the rider is picking items up FROM the
// shopper here, which is the real "handing the goods to the rider" moment
// the confirm call protects, not the later drop-off to the customer.
const markOutForDelivery = transitionHandler(["RIDER_ASSIGNED"], "OUT_FOR_DELIVERY", {
  requireRider: true,
  codeField: "pickupCode",
  codeErrorMessage: "Incorrect pickup code. Ask the shopper for the code on their screen.",
  requireConfirmCall: true,
});
// Distinct from the pickup-code/confirm-call gated handover itself
// (markOutForDelivery below) -- this is just a real "I'm here" signal so
// the shopper and customer both see genuine progress before anything else
// happens.
async function riderArrivedShopper(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.riderId !== req.user.riderProfile.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "RIDER_ASSIGNED") return res.status(409).json({ error: `Session must be RIDER_ASSIGNED (currently ${session.status}).` });

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { riderArrivedShopperAt: new Date() } });
    const io = req.app.get("io");
    io?.to(`shop-session:${session.id}`).emit("shop-session:rider-arrived-shopper", { sessionId: session.id });
    const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
    if (shopper) await notify(io, shopper.userId, "ORDER_UPDATE", "Rider has arrived", "Your rider has arrived to collect the items.", { sessionId: session.id });
    await notify(io, session.customerId, "ORDER_UPDATE", "Rider has arrived", "Your rider has arrived at the shopper's location to collect your items.", { sessionId: session.id });

    // Single combined insufficient-funds check, right here -- by now both
    // the real session fee (startPackaging) and the real rider fee
    // (findRider) are known, so this is the one moment that can compare
    // each against what was actually collected and ask for the exact
    // combined difference, instead of two separate earlier prompts.
    const sessionShortfallKobo = Math.max(0, updated.sessionFeeKobo - (updated.sessionFeeCollectedKobo ?? updated.sessionFeeKobo));
    const riderShortfallKobo = Math.max(0, updated.riderFeeKobo - (updated.riderFeeCollectedKobo ?? updated.riderFeeKobo));
    if (sessionShortfallKobo > 0 || riderShortfallKobo > 0) {
      const totalShortfallKobo = sessionShortfallKobo + riderShortfallKobo;
      io?.to(`shop-session:${session.id}`).emit("shop-session:insufficient-funds", { sessionId: session.id, sessionShortfallKobo, riderShortfallKobo, totalShortfallKobo });
      await notify(io, session.customerId, "ORDER_UPDATE", "Insufficient funds", `Your session needs ₦${Math.round(totalShortfallKobo / 100).toLocaleString()} more to complete — add funds to continue.`, { sessionId: session.id });
    }

    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

const markDelivered = transitionHandler(["OUT_FOR_DELIVERY"], "DELIVERED", {
  requireRider: true,
  codeField: "deliveryCode",
  codeErrorMessage: "Incorrect delivery code. Ask the customer for their code.",
  // RiderProfile.deliveries was previously a display-only field nothing
  // ever incremented (always whatever the seed set it to) -- this is the
  // real completion event, so it's the real place to count one.
  onSuccess: async (session, req) => {
    if (req.user.riderProfile) {
      await prisma.riderProfile.update({ where: { id: req.user.riderProfile.id }, data: { deliveries: { increment: 1 } } });
    }
    // Nothing told the shopper delivery actually happened -- their own
    // involvement doesn't end until this fires, and the home-screen
    // "track this delivery" banner relies on a real DELIVERED status to
    // know when to stop showing itself.
    const io = req.app.get("io");
    if (session.shopperId) {
      const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
      if (shopper) await notify(io, shopper.userId, "ORDER_UPDATE", "Delivery complete", "Your rider has delivered the items to the customer.", { sessionId: session.id }).catch(() => {});
    }
  },
});

// Distinct from markDelivered above (entering the code and confirming
// delivery) -- a real "I'm here" signal at the customer's door first, same
// pattern as riderArrivedShopper.
async function riderArrivedCustomer(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.riderId !== req.user.riderProfile.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "OUT_FOR_DELIVERY") return res.status(409).json({ error: `Session must be OUT_FOR_DELIVERY (currently ${session.status}).` });

    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { riderArrivedCustomerAt: new Date() } });
    const io = req.app.get("io");
    io?.to(`shop-session:${session.id}`).emit("shop-session:rider-arrived-customer", { sessionId: session.id });
    const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
    if (shopper) await notify(io, shopper.userId, "ORDER_UPDATE", "Rider has arrived", "Your rider has arrived at the customer's location.", { sessionId: session.id });
    await notify(io, session.customerId, "ORDER_UPDATE", "Rider has arrived", "Your rider has arrived — have your delivery code ready.", { sessionId: session.id });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// The shopper taps this once the rider has arrived at their location and
// the two of them have done the joint item check — invites the rider
// (physically present, joining via their own app) and the customer
// (joining remotely) into a real 3-way audio room so the rider can hear
// the customer confirm the items directly, before the shopper hands them
// over. Same confirmcall:* signaling relay as before (see live.js).
async function startConfirmCall(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id }, include: { rider: { select: { userId: true } } } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (session.shopperId !== req.user.shopperProfile.id) return res.status(403).json({ error: "You are not the shopper on this session." });
    if (session.status !== "RIDER_ASSIGNED") return res.status(409).json({ error: `Session must be RIDER_ASSIGNED (currently ${session.status}).` });

    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:confirm-call-invite", { sessionId: session.id });
    // A live socket toast only reaches whoever is already sitting on this
    // exact screen right now -- a real persisted notification means the
    // customer/rider still find out even if they're elsewhere in the app
    // (or offline) when the shopper starts the call, so it doesn't just
    // ring silently on their end.
    const io = req.app.get("io");
    await notify(io, session.customerId, "ORDER_UPDATE", "3-way call starting", "Your shopper is starting a 3-way call with you and the rider to confirm your items — expect it any moment.", { sessionId: session.id }).catch(() => {});
    if (session.rider?.userId) {
      await notify(io, session.rider.userId, "ORDER_UPDATE", "3-way call starting", "The shopper is starting a 3-way call with you and the customer to confirm the items — expect it any moment.", { sessionId: session.id }).catch(() => {});
    }
    res.json({ session });
  } catch (err) {
    next(err);
  }
}

// Any of the 3 real parties (rider, shopper, or customer) can mark the
// confirm call done — idempotent, since more than one side might tap it.
async function completeConfirmCall(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    const isParty =
      session.customerId === req.user.id ||
      (req.user.shopperProfile && session.shopperId === req.user.shopperProfile.id) ||
      (req.user.riderProfile && session.riderId === req.user.riderProfile.id);
    if (!isParty) return res.status(403).json({ error: "You are not a party to this session." });

    const updated = session.confirmCallCompletedAt
      ? session
      : await prisma.shopSession.update({ where: { id: session.id }, data: { confirmCallCompletedAt: new Date() } });

    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:confirm-call-completed", { sessionId: session.id });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// Shopper taps "Confirm Handover to Rider" after the 3-way call -- purely a
// live progress signal for the rider's and customer's own screens ("items
// handed over") so their copy updates for real instead of staying frozen
// on "confirming items" forever. The actual pickup transition still only
// happens once the rider enters the real pickup code via markOutForDelivery
// below -- this doesn't touch session.status at all.
async function confirmHandover(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    if (session.shopperId !== req.user.shopperProfile.id) return res.status(403).json({ error: "You are not the shopper on this session." });
    if (!session.confirmCallCompletedAt) return res.status(409).json({ error: "Complete the 3-way confirm call first." });

    const updated = session.handoverConfirmedAt
      ? session
      : await prisma.shopSession.update({ where: { id: session.id }, data: { handoverConfirmedAt: new Date() } });

    req.app.get("io")?.to(`shop-session:${session.id}`).emit("shop-session:handover-confirmed", { sessionId: session.id });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

async function confirmSession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (session.status !== "DELIVERED") return res.status(409).json({ error: "Session has not been marked delivered yet." });

    await escrow.releaseAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "Customer confirmed Shop-For-Me delivery" });
    await refundUnspentBudget(session);
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    closeSupportThreadForContext(session.id);
    await notifyPayoutRecipients(req.app.get("io"), updated);
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// The customer's deposit covers sessionFee + riderFee + a real items
// budget, but the shopper may never spend all of the items portion
// (fewer items approved than budgeted for). Neither of those first two
// fees is ever partially spent, so any leftover can only be in the
// items budget -- refunds exactly that difference back to the
// customer's wallet the moment the session completes, instead of it
// silently staying locked in escrow with nothing left to release it for.
async function refundUnspentBudget(session) {
  const budgetKobo = session.depositKobo - session.sessionFeeKobo - session.riderFeeKobo;
  if (budgetKobo <= 0) return;
  const paidToSellers = await prisma.sellerPayout.aggregate({
    where: { sessionId: session.id, status: { in: ["PENDING", "PROCESSING", "PAID"] } },
    _sum: { amountKobo: true },
  });
  const unspentKobo = budgetKobo - (paidToSellers._sum.amountKobo || 0);
  if (unspentKobo > 0) {
    await walletSvc.creditWallet(session.customerId, unspentKobo, "ADJUSTMENT", { contextType: "SHOP_SESSION", contextId: session.id, description: "Unspent shopping budget refunded on session completion" });
  }
}

// escrow.service.js's runAutoReleaseSweep releases individual holds
// generically across every context (bookings included) with no idea
// which session/booking they belonged to -- a Shop-For-Me session whose
// customer never manually confirmed still needed the SAME completion
// side effects (unspent-budget refund, payout notifications, status ->
// COMPLETED) once its holds finish auto-releasing, which confirmSession
// above already does for the manual-confirm path. Runs as its own sweep
// (registered in live.js) rather than teaching the generic escrow sweep
// about Shop-For-Me specifically -- checks every still-DELIVERED session
// and finalizes any whose holds have all actually released.
async function finalizeAutoReleasedSessions(io) {
  const sessions = await prisma.shopSession.findMany({ where: { status: "DELIVERED" } });
  let finalized = 0;
  for (const session of sessions) {
    const stillHeld = await prisma.escrowHold.count({ where: { contextType: "SHOP_SESSION", shopSessionId: session.id, status: "HELD" } });
    if (stillHeld > 0) continue;
    await refundUnspentBudget(session);
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    closeSupportThreadForContext(session.id);
    await notifyPayoutRecipients(io, updated);
    finalized++;
  }
  return finalized;
}

// Neither the shopper's nor the rider's escrow release ever told them
// anything got paid -- releaseAllHoldsForContext is generic across every
// context (bookings already send their own completion notify()
// elsewhere, which is why this lives here and not inside the shared
// escrow service, to avoid double-notifying a booking's vendor).
async function notifyPayoutRecipients(io, session) {
  const amountText = (kobo) => `₦${Math.round(kobo / 100).toLocaleString()}`;
  if (session.shopperId) {
    const shopper = await prisma.shopperProfile.findUnique({ where: { id: session.shopperId }, select: { userId: true } });
    if (shopper) {
      await notify(io, shopper.userId, "ORDER_UPDATE", "Payment released", `Your shopper fee for this session (${amountText(session.sessionFeeKobo)}) has been released to your wallet.`, { sessionId: session.id }).catch(() => {});
    }
  }
  if (session.riderId) {
    const rider = await prisma.riderProfile.findUnique({ where: { id: session.riderId }, select: { userId: true } });
    if (rider) {
      await notify(io, rider.userId, "ORDER_UPDATE", "Payment released", `Your delivery fee for this session (${amountText(session.riderFeeKobo)}) has been released to your wallet.`, { sessionId: session.id }).catch(() => {});
    }
  }
}

async function cancelSession(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.customerId !== req.user.id) return res.status(404).json({ error: "Shop session not found." });
    if (["DELIVERED", "COMPLETED", "CANCELLED"].includes(session.status)) return res.status(409).json({ error: `Session is already ${session.status.toLowerCase()}.` });

    await escrow.refundAllHoldsForContext({ contextType: "SHOP_SESSION", shopSessionId: session.id }, { description: "Session cancelled by customer" });
    const updated = await prisma.shopSession.update({ where: { id: session.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    closeSupportThreadForContext(session.id);
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
}

// Shopper allocates the deposited shopping budget (deposit minus the
// session fee already earmarked for them) across the market sellers they
// bought from, paying each directly by bank transfer.
// Real emergency signal from the customer's live-tracking screen -- creates
// a genuinely visible SupportTicket (shows up in the admin's existing
// Support Tickets list, flagged as urgent via its own category) AND
// notifies every admin directly and immediately, rather than waiting on
// someone to happen to check a dashboard count.
async function sendSOS(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: "Shop session not found." });
    assertSessionAccess(req, session);

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        context: "SHOP_SESSION",
        contextId: session.id,
        category: "🆘 SOS — Emergency Alert",
        description: req.body.message || "Emergency SOS triggered from an active Shop-For-Me session.",
      },
    });

    const io = req.app.get("io");
    const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
    for (const admin of admins) {
      await notify(io, admin.id, "ORDER_UPDATE", "🆘 SOS Alert", `${req.user.name || "A user"} triggered an emergency SOS on an active Shop-For-Me session.`, { sessionId: session.id, ticketId: ticket.id });
    }
    res.status(201).json({ ticket });
  } catch (err) {
    next(err);
  }
}

async function confirmSellerPayouts(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const session = await prisma.shopSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.shopperId !== req.user.shopperProfile.id) return res.status(404).json({ error: "Shop session not found." });

    const { allocations, payoutMethod } = req.body; // [{ sellerId, amountKobo }] — bankCode now comes from the seller's own saved record, not re-sent by the client
    if (!Array.isArray(allocations) || allocations.length === 0) return res.status(400).json({ error: "At least one payout allocation is required." });
    const method = payoutMethod === "ESCROW_DIRECT" ? "ESCROW_DIRECT" : "PAYSTACK";

    const budgetKobo = session.depositKobo - session.sessionFeeKobo - session.riderFeeKobo;
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

      // ESCROW_DIRECT: no real Paystack transfer at all -- the app trusts
      // the shopper has already paid the seller some other way (cash, a
      // personal transfer at the market) and just records the amount as
      // spent against the tracked shopping budget, same accounting/cap
      // check above as the Paystack path, just skipping the external rail.
      if (method === "ESCROW_DIRECT") {
        await prisma.sellerPayout.create({
          data: { sessionId: session.id, sellerId: seller.id, amountKobo: alloc.amountKobo, reference, status: "PAID", paidAt: new Date() },
        });
        results.push({ sellerId: seller.id, status: "PAID" });
        continue;
      }

      const payout = await prisma.sellerPayout.create({
        data: { sessionId: session.id, sellerId: seller.id, amountKobo: alloc.amountKobo, reference },
      });
      // DEV_BYPASS_PAYMENTS=true (same flag debitWallet/createManualPaymentRequest
      // already honor) skips the real Paystack bank-account resolution and
      // transfer entirely -- registered test sellers never have real bank
      // details, so createTransferRecipient always rejected them with
      // "account cannot be resolved" and there was no way to exercise this
      // flow at all without a real payout rail. Marks PAID immediately,
      // same as the ESCROW_DIRECT method above. Unset before production --
      // a real Paystack payout must still actually verify and move money.
      if (walletSvc.devBypassEnabled()) {
        await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: "PAID", paidAt: new Date() } });
        results.push({ sellerId: seller.id, status: "PAID" });
        continue;
      }
      try {
        if (!seller.bankCode) {
          results.push({ sellerId: seller.id, status: "FAILED", error: "This seller has no bank code on file — re-register them with a bank selected from the list." });
          await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: "FAILED" } });
          continue;
        }
        const recipient = await paystack.createTransferRecipient({ name: seller.bankAccountName, accountNumber: seller.bankAccountNumber, bankCode: seller.bankCode });
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
  addItemMidCall,
  priceItem,
  approveItem,
  removeItem,
  resetItemPricing,
  topUpItems,
  paySession,
  matchSession,
  startCall,
  pauseCall,
  resumeCall,
  startPackaging,
  payCallTopUp,
  requestEmergencyEnd,
  confirmEmergencyEnd,
  sendSOS,
  findRider,
  payRiderFeeTopUp,
  payShopSessionShortfall,
  acceptDelivery,
  riderArrivedShopper,
  markOutForDelivery,
  markDelivered,
  riderArrivedCustomer,
  startConfirmCall,
  completeConfirmCall,
  confirmHandover,
  confirmSession,
  finalizeAutoReleasedSessions,
  cancelSession,
  confirmSellerPayouts,
  expireStaleSearchingSessions,
  expireStaleLiveSessions,
};
