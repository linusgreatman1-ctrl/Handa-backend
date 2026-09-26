const prisma = require("../config/db");
const { notify, notifyAllCaterers } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

// Broadcast one catering request to every qualified (CATERING) vendor, let
// them each submit a priced proposal, and let the customer compare and pick
// a winner -- the exact same RFP layer eventRequests.controller.js already
// runs for Event Planners, just scoped to the standalone CATERING vendor
// type. Accepting a proposal creates a real Booking (type CATERING) and
// hands off to that model's existing negotiated-release escrow/payment/
// completion machinery unchanged; this controller only owns the request ->
// proposals -> pick stage before a Booking exists.

async function createCateringRequest(req, res, next) {
  try {
    const { eventType, eventDate, eventTime, venue, guestCount, budgetKobo, servicesRequested, mealPreferences, notes, posterName, posterPhone, timeframe } = req.body;
    if (!eventType || !eventDate || !venue) {
      return res.status(400).json({ error: "eventType, eventDate, and venue are required." });
    }
    const request = await prisma.cateringRequest.create({
      data: {
        customerId: req.user.id,
        posterName: posterName || req.user.name || null,
        posterPhone: posterPhone || req.user.phone || null,
        eventType,
        eventDate: new Date(eventDate),
        eventTime: eventTime || null,
        venue,
        guestCount: guestCount != null ? Number(guestCount) : null,
        budgetKobo: budgetKobo != null ? Number(budgetKobo) : null,
        servicesRequested: Array.isArray(servicesRequested) ? servicesRequested : [],
        mealPreferences: mealPreferences || null,
        notes: notes || null,
        timeframe: timeframe || null,
      },
    });
    const io = req.app.get("io");
    io?.to("dispatch:caterers").emit("catering-request:updated", { requestId: request.id, reason: "created" });
    notifyAllCaterers(io, "New catering request", `A customer posted a new ${eventType} catering request${venue ? " in " + venue : ""} — submit a proposal.`, { cateringRequestId: request.id }).catch(() => {});
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
}

async function listCateringRequests(req, res, next) {
  try {
    const { as, status } = req.query;

    if (as === "vendor") {
      if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "CATERING") {
        return res.status(403).json({ error: "Only catering accounts can browse catering requests." });
      }
      const requestsWhere = status
        ? { status }
        : { OR: [{ status: "OPEN" }, { proposals: { some: { vendorId: req.user.vendorProfile.id } } }] };
      const requests = await prisma.cateringRequest.findMany({
        where: requestsWhere,
        include: {
          customer: { select: { name: true } },
          _count: { select: { proposals: true } },
          proposals: { where: { vendorId: req.user.vendorProfile.id }, select: { id: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return res.json({ requests });
    }

    const requests = await prisma.cateringRequest.findMany({
      where: { customerId: req.user.id, ...(status && { status }) },
      include: { _count: { select: { proposals: { where: { status: { notIn: ["DECLINED", "WITHDRAWN"] } } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
}

async function getCateringRequest(req, res, next) {
  try {
    const request = await prisma.cateringRequest.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { name: true, phone: true } },
        proposals: { include: { vendor: { select: { bizName: true, ratingAvg: true, ratingCount: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!request) return res.status(404).json({ error: "Catering request not found." });

    const isOwner = request.customerId === req.user.id;
    const myVendorId = req.user.vendorProfile?.id;

    if (!isOwner) {
      request.proposals = request.proposals.filter((p) => p.vendorId === myVendorId);
    }

    res.json({ request });
  } catch (err) {
    next(err);
  }
}

async function submitProposal(req, res, next) {
  try {
    if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "CATERING") {
      return res.status(403).json({ error: "Only catering accounts can submit proposals." });
    }
    const { priceKobo, servicesIncluded, timeline, notes } = req.body;
    if (!priceKobo || priceKobo <= 0) return res.status(400).json({ error: "A valid priceKobo is required." });

    const request = await prisma.cateringRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Catering request not found." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This catering request is no longer open." });

    const existing = await prisma.cateringProposal.findFirst({
      where: { cateringRequestId: request.id, vendorId: req.user.vendorProfile.id, status: "PENDING" },
    });
    if (existing) return res.status(409).json({ error: "You already have a pending proposal on this request." });

    const proposal = await prisma.cateringProposal.create({
      data: {
        cateringRequestId: request.id,
        vendorId: req.user.vendorProfile.id,
        priceKobo: Number(priceKobo),
        servicesIncluded: Array.isArray(servicesIncluded) ? servicesIncluded : [],
        timeline: timeline || null,
        notes: notes || null,
      },
    });

    const io = req.app.get("io");
    await notify(
      io,
      request.customerId,
      "ORDER_UPDATE",
      "New proposal received",
      `A caterer submitted a proposal for your ${request.eventType} catering request.`,
      { cateringRequestId: request.id }
    );
    io?.to(`user:${request.customerId}`).emit("catering-request:updated", { requestId: request.id, reason: "proposal" });

    res.status(201).json({ proposal });
  } catch (err) {
    next(err);
  }
}

async function acceptProposal(req, res, next) {
  try {
    const request = await prisma.cateringRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Catering request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this catering request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This catering request is no longer open." });

    const proposal = await prisma.cateringProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.cateringRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    const io = req.app.get("io");

    const mergedServiceNames = [];
    const seenLower = new Set();
    for (const name of [...(request.servicesRequested || []), ...(proposal.servicesIncluded || [])]) {
      const key = String(name).trim().toLowerCase();
      if (!key || seenLower.has(key)) continue;
      seenLower.add(key);
      mergedServiceNames.push(String(name).trim());
    }
    const selectedItemsSnapshot = mergedServiceNames.map((name) => ({ name, qty: 1, priceKobo: 0, custom: true }));

    const booking = await prisma.$transaction(async (tx) => {
      // Same negotiated-release pattern as EventProposal.acceptProposal --
      // full price pays into escrow now, vendor already committed to it by
      // proposing, so orderFlow.confirmBookingPayment auto-CONFIRMs this
      // booking (it detects the CateringProposal.bookingId link) instead of
      // leaving it at PAID awaiting a vendor decision they already made.
      const newBooking = await tx.booking.create({
        data: {
          bookingNumber: generateReference("CAT"),
          type: "CATERING",
          status: "REQUESTED",
          customerId: request.customerId,
          vendorId: proposal.vendorId,
          eventDate: request.eventDate,
          eventTime: request.eventTime,
          venue: request.venue,
          guestCount: request.guestCount,
          eventType: request.eventType,
          selectedItems: selectedItemsSnapshot,
          notes: [request.mealPreferences ? "Meals: " + request.mealPreferences : null, request.notes, proposal.notes].filter(Boolean).join(" — ") || null,
          paymentMethod: "CARD",
          totalKobo: proposal.priceKobo,
        },
      });

      await tx.cateringProposal.update({ where: { id: proposal.id }, data: { status: "ACCEPTED", bookingId: newBooking.id } });
      await tx.cateringProposal.updateMany({
        where: { cateringRequestId: request.id, id: { not: proposal.id }, status: "PENDING" },
        data: { status: "DECLINED" },
      });
      await tx.cateringRequest.update({
        where: { id: request.id },
        data: { status: "PROPOSAL_ACCEPTED", acceptedProposalId: proposal.id, acceptedAt: new Date() },
      });

      return newBooking;
    });

    const losers = await prisma.cateringProposal.findMany({ where: { cateringRequestId: request.id, status: "DECLINED" } });
    await notify(io, req.user.id, "ORDER_UPDATE", "Proposal accepted", `Pay ₦${Math.round(proposal.priceKobo / 100).toLocaleString()} into escrow to confirm your catering booking.`, { bookingId: booking.id });
    for (const loser of losers) {
      const vendorUser = await prisma.vendorProfile.findUnique({ where: { id: loser.vendorId }, select: { userId: true } });
      if (vendorUser) {
        await notify(io, vendorUser.userId, "ORDER_UPDATE", "Proposal not selected", "The customer chose a different proposal for this catering request.", { cateringRequestId: request.id });
      }
    }
    const winnerVendor = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (winnerVendor) {
      await notify(io, winnerVendor.userId, "ORDER_UPDATE", "Proposal accepted!", "Your catering proposal was accepted -- the customer is completing payment now.", { bookingId: booking.id });
    }
    io?.to("dispatch:caterers").emit("catering-request:updated", { requestId: request.id, reason: "accepted" });
    io?.to(`user:${request.customerId}`).emit("catering-request:updated", { requestId: request.id, reason: "accepted" });

    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

async function declineProposal(req, res, next) {
  try {
    const request = await prisma.cateringRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Catering request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this catering request." });

    const proposal = await prisma.cateringProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.cateringRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    const updated = await prisma.cateringProposal.update({ where: { id: proposal.id }, data: { status: "DECLINED" } });

    const io = req.app.get("io");
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (vendorProfile) {
      await notify(
        io,
        vendorProfile.userId,
        "ORDER_UPDATE",
        "Proposal Declined",
        `Your proposal (₦${Math.round(proposal.priceKobo / 100).toLocaleString()}) for the ${request.eventType} catering request was declined by the customer.`,
        { cateringRequestId: request.id }
      );
      io?.to(`vendor:${proposal.vendorId}`).emit("catering-request:updated", { requestId: request.id, reason: "proposal-declined" });
    }
    res.json({ proposal: updated });
  } catch (err) {
    next(err);
  }
}

async function cancelCateringRequest(req, res, next) {
  try {
    const request = await prisma.cateringRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Catering request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this catering request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "Only an open request can be cancelled." });

    await prisma.$transaction([
      prisma.cateringRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }),
      prisma.cateringProposal.updateMany({ where: { cateringRequestId: request.id, status: "PENDING" }, data: { status: "WITHDRAWN" } }),
    ]);
    req.app.get("io")?.to("dispatch:caterers").emit("catering-request:updated", { requestId: request.id, reason: "cancelled" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { createCateringRequest, listCateringRequests, getCateringRequest, submitProposal, acceptProposal, declineProposal, cancelCateringRequest };
