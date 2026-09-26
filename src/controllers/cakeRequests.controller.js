const prisma = require("../config/db");
const { notify, notifyAllCakeVendors } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

// Same request -> proposals -> accept pattern as eventRequests/cateringRequests
// controllers, for custom cakes that aren't one of a vendor's standard
// catalog designs (see MenuItem.leadTimeNote for the "readily available"
// path instead). Accepting a proposal creates a real Booking (type CAKE),
// which then goes through the normal direct-booking accept/decline flow
// and the rider-delivery leg in bookings.controller.js.

async function createCakeRequest(req, res, next) {
  try {
    const { occasion, neededByDate, neededByTime, deliveryAddress, servings, flavourPreference, budgetKobo, notes, posterName, posterPhone } = req.body;
    if (!occasion || !neededByDate) {
      return res.status(400).json({ error: "occasion and neededByDate are required." });
    }
    if (!deliveryAddress || !String(deliveryAddress).trim()) {
      return res.status(400).json({ error: "A delivery address is required." });
    }
    const referencePhotoUrls = (req.files || []).map((f) => `/uploads/${f.filename}`);
    const request = await prisma.cakeRequest.create({
      data: {
        customerId: req.user.id,
        posterName: posterName || req.user.name || null,
        posterPhone: posterPhone || req.user.phone || null,
        occasion,
        neededByDate: new Date(neededByDate),
        neededByTime: neededByTime || null,
        deliveryAddress: String(deliveryAddress).trim(),
        servings: servings != null ? Number(servings) : null,
        flavourPreference: flavourPreference || null,
        budgetKobo: budgetKobo != null ? Number(budgetKobo) : null,
        notes: notes || null,
        referencePhotoUrls,
      },
    });
    const io = req.app.get("io");
    io?.to("dispatch:cakevendors").emit("cake-request:updated", { requestId: request.id, reason: "created" });
    notifyAllCakeVendors(io, "New cake request", `A customer posted a new ${occasion} cake request — submit a proposal.`, { cakeRequestId: request.id }).catch(() => {});
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
}

async function listCakeRequests(req, res, next) {
  try {
    const { as, status } = req.query;

    if (as === "vendor") {
      if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "CAKE") {
        return res.status(403).json({ error: "Only cake vendor accounts can browse cake requests." });
      }
      const requestsWhere = status
        ? { status }
        : { OR: [{ status: "OPEN" }, { proposals: { some: { vendorId: req.user.vendorProfile.id } } }] };
      const requests = await prisma.cakeRequest.findMany({
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

    const requests = await prisma.cakeRequest.findMany({
      where: { customerId: req.user.id, ...(status && { status }) },
      include: { _count: { select: { proposals: { where: { status: { notIn: ["DECLINED", "WITHDRAWN"] } } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
}

async function getCakeRequest(req, res, next) {
  try {
    const request = await prisma.cakeRequest.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { name: true, phone: true } },
        proposals: { include: { vendor: { select: { bizName: true, ratingAvg: true, ratingCount: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!request) return res.status(404).json({ error: "Cake request not found." });

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
    if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "CAKE") {
      return res.status(403).json({ error: "Only cake vendor accounts can submit proposals." });
    }
    const { priceKobo, timeline, notes } = req.body;
    if (!priceKobo || priceKobo <= 0) return res.status(400).json({ error: "A valid priceKobo is required." });

    const request = await prisma.cakeRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Cake request not found." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This cake request is no longer open." });

    const existing = await prisma.cakeProposal.findFirst({
      where: { cakeRequestId: request.id, vendorId: req.user.vendorProfile.id, status: "PENDING" },
    });
    if (existing) return res.status(409).json({ error: "You already have a pending proposal on this request." });

    const proposal = await prisma.cakeProposal.create({
      data: {
        cakeRequestId: request.id,
        vendorId: req.user.vendorProfile.id,
        priceKobo: Number(priceKobo),
        timeline: timeline || null,
        notes: notes || null,
      },
    });

    const io = req.app.get("io");
    await notify(io, request.customerId, "ORDER_UPDATE", "New proposal received", `A cake designer submitted a proposal for your ${request.occasion} cake request.`, { cakeRequestId: request.id });
    io?.to(`user:${request.customerId}`).emit("cake-request:updated", { requestId: request.id, reason: "proposal" });

    res.status(201).json({ proposal });
  } catch (err) {
    next(err);
  }
}

async function acceptProposal(req, res, next) {
  try {
    const request = await prisma.cakeRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Cake request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this cake request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This cake request is no longer open." });

    const proposal = await prisma.cakeProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.cakeRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    // Collected on the request itself now (so bakers see it when pricing),
    // but still confirmable/changeable at accept time -- whatever the
    // customer sends here wins, falling back to the request's own address.
    const deliveryAddress = (req.body.deliveryAddress && String(req.body.deliveryAddress).trim()) || request.deliveryAddress;
    if (!deliveryAddress) {
      return res.status(400).json({ error: "A delivery address is required to accept a proposal." });
    }

    const io = req.app.get("io");
    // Rider fee priced upfront and paid into escrow with the proposal price,
    // same as a direct cake order (bookings.controller.js createBooking).
    const { estimateCakeRiderFee } = require("./bookings.controller");
    const { feeKobo: riderFeeKobo } = await estimateCakeRiderFee(proposal.vendorId, deliveryAddress, request.customerId);

    const booking = await prisma.$transaction(async (tx) => {
      const newBooking = await tx.booking.create({
        data: {
          bookingNumber: generateReference("CAKE"),
          type: "CAKE",
          status: "REQUESTED",
          customerId: request.customerId,
          vendorId: proposal.vendorId,
          eventDate: request.neededByDate,
          eventTime: request.neededByTime || null,
          venue: String(deliveryAddress).trim(),
          guestCount: request.servings,
          eventType: request.occasion,
          selectedItems: [{ name: request.occasion + " Custom Cake", qty: 1, priceKobo: proposal.priceKobo, custom: true }],
          notes: [request.notes, proposal.timeline ? "Ready: " + proposal.timeline : null, proposal.notes].filter(Boolean).join(" — ") || null,
          paymentMethod: "CARD",
          riderFeeKobo,
          totalKobo: proposal.priceKobo + riderFeeKobo,
        },
      });

      await tx.cakeProposal.update({ where: { id: proposal.id }, data: { status: "ACCEPTED", bookingId: newBooking.id } });
      await tx.cakeProposal.updateMany({
        where: { cakeRequestId: request.id, id: { not: proposal.id }, status: "PENDING" },
        data: { status: "DECLINED" },
      });
      await tx.cakeRequest.update({
        where: { id: request.id },
        data: { status: "PROPOSAL_ACCEPTED", acceptedProposalId: proposal.id, acceptedAt: new Date() },
      });

      return newBooking;
    });

    const losers = await prisma.cakeProposal.findMany({ where: { cakeRequestId: request.id, status: "DECLINED" } });
    await notify(io, req.user.id, "ORDER_UPDATE", "Proposal accepted", `Pay ₦${Math.round((proposal.priceKobo + riderFeeKobo) / 100).toLocaleString()} (cake + delivery) into escrow to confirm your cake order.`, { bookingId: booking.id });
    for (const loser of losers) {
      const vendorUser = await prisma.vendorProfile.findUnique({ where: { id: loser.vendorId }, select: { userId: true } });
      if (vendorUser) {
        await notify(io, vendorUser.userId, "ORDER_UPDATE", "Proposal not selected", "The customer chose a different proposal for this cake request.", { cakeRequestId: request.id });
      }
    }
    const winnerVendor = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (winnerVendor) {
      await notify(io, winnerVendor.userId, "ORDER_UPDATE", "Proposal accepted!", "Your cake proposal was accepted -- the customer is completing payment now.", { bookingId: booking.id });
    }
    io?.to("dispatch:cakevendors").emit("cake-request:updated", { requestId: request.id, reason: "accepted" });
    io?.to(`user:${request.customerId}`).emit("cake-request:updated", { requestId: request.id, reason: "accepted" });

    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

async function declineProposal(req, res, next) {
  try {
    const request = await prisma.cakeRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Cake request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this cake request." });

    const proposal = await prisma.cakeProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.cakeRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    const updated = await prisma.cakeProposal.update({ where: { id: proposal.id }, data: { status: "DECLINED" } });

    const io = req.app.get("io");
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (vendorProfile) {
      await notify(
        io,
        vendorProfile.userId,
        "ORDER_UPDATE",
        "Proposal Declined",
        `Your proposal (₦${Math.round(proposal.priceKobo / 100).toLocaleString()}) for the ${request.occasion} cake request was declined by the customer.`,
        { cakeRequestId: request.id }
      );
      io?.to(`vendor:${proposal.vendorId}`).emit("cake-request:updated", { requestId: request.id, reason: "proposal-declined" });
    }
    res.json({ proposal: updated });
  } catch (err) {
    next(err);
  }
}

async function cancelCakeRequest(req, res, next) {
  try {
    const request = await prisma.cakeRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Cake request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this cake request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "Only an open request can be cancelled." });

    await prisma.$transaction([
      prisma.cakeRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }),
      prisma.cakeProposal.updateMany({ where: { cakeRequestId: request.id, status: "PENDING" }, data: { status: "WITHDRAWN" } }),
    ]);
    req.app.get("io")?.to("dispatch:cakevendors").emit("cake-request:updated", { requestId: request.id, reason: "cancelled" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { createCakeRequest, listCakeRequests, getCakeRequest, submitProposal, acceptProposal, declineProposal, cancelCakeRequest };
