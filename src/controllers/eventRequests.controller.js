const prisma = require("../config/db");
const { notify, notifyAllEventPlanners } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

// Broadcast one event request to every qualified (EVENT_PLANNER) vendor,
// let them each submit a priced proposal, and let the customer compare
// and pick a winner — the RFP layer described in the architecture doc's
// event-proposal section. Accepting a proposal creates a real Booking and
// hands off to that model's existing escrow/payment/completion machinery
// unchanged; this controller only owns the request → proposals → pick
// stage before a Booking exists.

async function createEventRequest(req, res, next) {
  try {
    const { eventType, eventDate, venue, guestCount, budgetKobo, servicesRequested, notes, posterName, posterPhone, timeframe } = req.body;
    if (!eventType || !eventDate || !venue) {
      return res.status(400).json({ error: "eventType, eventDate, and venue are required." });
    }
    // Explicit poster name/phone on the request itself, distinct from the
    // account's own User fields -- defaults to the account's real
    // name/phone when the customer leaves them blank (the common case),
    // but stays editable for someone posting on behalf of another person.
    const request = await prisma.eventRequest.create({
      data: {
        customerId: req.user.id,
        posterName: posterName || req.user.name || null,
        posterPhone: posterPhone || req.user.phone || null,
        eventType,
        eventDate: new Date(eventDate),
        venue,
        guestCount: guestCount != null ? Number(guestCount) : null,
        budgetKobo: budgetKobo != null ? Number(budgetKobo) : null,
        servicesRequested: Array.isArray(servicesRequested) ? servicesRequested : [],
        notes: notes || null,
        timeframe: timeframe || null,
      },
    });
    // Every qualified (EVENT_PLANNER) vendor currently connected sees this
    // the moment it's posted -- previously only ever appeared once a
    // planner happened to reload/reopen their dashboard.
    const io = req.app.get("io");
    io?.to("dispatch:eventplanners").emit("event-request:updated", { requestId: request.id, reason: "created" });
    // A real Notification row + bell push, for every EP whether or not
    // they're currently connected -- the socket broadcast above only ever
    // helped a planner already sitting on their dashboard's request list
    // at the exact moment this fires.
    notifyAllEventPlanners(io, "New event request", `A customer posted a new ${eventType} request${venue ? " in " + venue : ""} — submit a proposal.`, { eventRequestId: request.id }).catch(() => {});
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
}

async function listEventRequests(req, res, next) {
  try {
    const { as, status } = req.query;

    if (as === "vendor") {
      if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "EVENT_PLANNER") {
        return res.status(403).json({ error: "Only event planner accounts can browse event requests." });
      }
      // No explicit status: every currently-open request, plus every
      // request this vendor has ever proposed on regardless of its status
      // (the "Event Requests" full-history view). An explicit status=OPEN
      // keeps the original dashboard-only behavior unchanged.
      const requestsWhere = status
        ? { status }
        : { OR: [{ status: "OPEN" }, { proposals: { some: { vendorId: req.user.vendorProfile.id } } }] };
      const requests = await prisma.eventRequest.findMany({
        where: requestsWhere,
        include: {
          customer: { select: { name: true } },
          _count: { select: { proposals: true } },
          // The calling vendor's own proposal on this request, if any --
          // lets the frontend show "Proposal Submitted" instead of
          // re-offering "Submit Proposal" on a request they already bid on.
          proposals: { where: { vendorId: req.user.vendorProfile.id }, select: { id: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return res.json({ requests });
    }

    const requests = await prisma.eventRequest.findMany({
      where: { customerId: req.user.id, ...(status && { status }) },
      // Counts only PENDING/ACCEPTED proposals -- a DECLINED or WITHDRAWN
      // one is no longer anything the customer needs to see or act on, so
      // it shouldn't inflate "N Proposal(s) Received" or make the card
      // look like there's something new to look at.
      include: { _count: { select: { proposals: { where: { status: { notIn: ["DECLINED", "WITHDRAWN"] } } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
}

async function getEventRequest(req, res, next) {
  try {
    const request = await prisma.eventRequest.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { name: true, phone: true } },
        proposals: { include: { vendor: { select: { bizName: true, ratingAvg: true, ratingCount: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!request) return res.status(404).json({ error: "Event request not found." });

    const isOwner = request.customerId === req.user.id;
    const myVendorId = req.user.vendorProfile?.id;

    if (!isOwner) {
      // A planner sees the request itself, but only their own proposal —
      // not competitors' bids.
      request.proposals = request.proposals.filter((p) => p.vendorId === myVendorId);
    }

    res.json({ request });
  } catch (err) {
    next(err);
  }
}

async function submitProposal(req, res, next) {
  try {
    if (!req.user.vendorProfile || req.user.vendorProfile.vtype !== "EVENT_PLANNER") {
      return res.status(403).json({ error: "Only event planner accounts can submit proposals." });
    }
    const { priceKobo, servicesIncluded, timeline, notes } = req.body;
    if (!priceKobo || priceKobo <= 0) return res.status(400).json({ error: "A valid priceKobo is required." });

    const request = await prisma.eventRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Event request not found." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This event request is no longer open." });

    const existing = await prisma.eventProposal.findFirst({
      where: { eventRequestId: request.id, vendorId: req.user.vendorProfile.id, status: "PENDING" },
    });
    if (existing) return res.status(409).json({ error: "You already have a pending proposal on this request." });

    const proposal = await prisma.eventProposal.create({
      data: {
        eventRequestId: request.id,
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
      `An event planner submitted a proposal for your ${request.eventType} request.`,
      { eventRequestId: request.id }
    );
    // The customer's own open "My Requests"/detail view live-refreshes
    // instead of only ever showing the new proposal after a manual reload.
    io?.to(`user:${request.customerId}`).emit("event-request:updated", { requestId: request.id, reason: "proposal" });

    res.status(201).json({ proposal });
  } catch (err) {
    next(err);
  }
}

async function acceptProposal(req, res, next) {
  try {
    const request = await prisma.eventRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Event request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this event request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "This event request is no longer open." });

    const proposal = await prisma.eventProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.eventRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    const io = req.app.get("io");

    // What the customer originally asked for (request.servicesRequested)
    // merged with what the winning planner actually offered
    // (proposal.servicesIncluded) -- neither ever carried through into the
    // real Booking before, so the booking detail screen showed no items at
    // all for a proposal-won booking, even though both sides had already
    // agreed on a real list of services. Deduped case-insensitively;
    // stored in the exact selectedItems shape the booking-detail screens
    // already render (name + qty), zero-priced since these are descriptive
    // service labels, not individually priced line items -- the real total
    // is proposal.priceKobo as a whole.
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
      // Event Planning bookings no longer go through escrow at all (see
      // bookings.controller.js's acceptBooking) -- the planner already
      // committed to this price by proposing, and there's nothing for the
      // customer to pay through the app, so this goes straight to
      // CONFIRMED, matching exactly where acceptBooking sends a normal EP
      // booking. paymentMethod is required by the schema but inapplicable
      // here -- CASH_ON_DELIVERY is the closest real meaning ("settled
      // directly, not through the app"); the frontend's booking-detail
      // view already overrides the displayed text for any EP booking
      // regardless of this raw value.
      const newBooking = await tx.booking.create({
        data: {
          bookingNumber: generateReference("EVT"),
          type: "EVENT_PLANNING",
          status: "CONFIRMED",
          customerId: request.customerId,
          vendorId: proposal.vendorId,
          eventDate: request.eventDate,
          venue: request.venue,
          guestCount: request.guestCount,
          selectedItems: selectedItemsSnapshot,
          notes: [request.notes, proposal.notes].filter(Boolean).join(" — ") || null,
          paymentMethod: "CASH_ON_DELIVERY",
          totalKobo: proposal.priceKobo,
        },
      });

      await tx.eventProposal.update({ where: { id: proposal.id }, data: { status: "ACCEPTED", bookingId: newBooking.id } });
      await tx.eventProposal.updateMany({
        where: { eventRequestId: request.id, id: { not: proposal.id }, status: "PENDING" },
        data: { status: "DECLINED" },
      });
      await tx.eventRequest.update({
        where: { id: request.id },
        data: { status: "PROPOSAL_ACCEPTED", acceptedProposalId: proposal.id, acceptedAt: new Date() },
      });

      return newBooking;
    });

    const losers = await prisma.eventProposal.findMany({ where: { eventRequestId: request.id, status: "DECLINED" } });
    await notify(io, req.user.id, "ORDER_UPDATE", "Proposal accepted", "Your event booking is confirmed! Payment is arranged directly with your planner, outside the app.", { bookingId: booking.id });
    for (const loser of losers) {
      const vendorUser = await prisma.vendorProfile.findUnique({ where: { id: loser.vendorId }, select: { userId: true } });
      if (vendorUser) {
        await notify(io, vendorUser.userId, "ORDER_UPDATE", "Proposal not selected", "The customer chose a different proposal for this event request.", { eventRequestId: request.id });
      }
    }
    const winnerVendor = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (winnerVendor) {
      await notify(io, winnerVendor.userId, "ORDER_UPDATE", "Proposal accepted!", "Your event proposal was accepted -- the customer has booked you.", { bookingId: booking.id });
    }
    // The request is no longer OPEN -- every other planner's dashboard
    // list live-drops it instead of only on their next reload; the
    // customer's own view live-updates too.
    io?.to("dispatch:eventplanners").emit("event-request:updated", { requestId: request.id, reason: "accepted" });
    io?.to(`user:${request.customerId}`).emit("event-request:updated", { requestId: request.id, reason: "accepted" });

    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

// Declines exactly ONE proposal -- unlike acceptProposal, which closes the
// whole request and auto-declines every other one. This only ever touches
// the single proposal the customer picked, leaving the request OPEN and
// every other proposal untouched, so the customer can keep comparing and
// decline/accept others independently.
async function declineProposal(req, res, next) {
  try {
    const request = await prisma.eventRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Event request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this event request." });

    const proposal = await prisma.eventProposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal || proposal.eventRequestId !== request.id) return res.status(404).json({ error: "Proposal not found." });
    if (proposal.status !== "PENDING") return res.status(400).json({ error: "This proposal is no longer pending." });

    const updated = await prisma.eventProposal.update({ where: { id: proposal.id }, data: { status: "DECLINED" } });

    const io = req.app.get("io");
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true } });
    if (vendorProfile) {
      await notify(
        io,
        vendorProfile.userId,
        "ORDER_UPDATE",
        "Proposal Declined",
        `Your proposal (₦${Math.round(proposal.priceKobo / 100).toLocaleString()}) for the ${request.eventType} request was declined by the customer.`,
        { eventRequestId: request.id }
      );
      io?.to(`vendor:${proposal.vendorId}`).emit("event-request:updated", { requestId: request.id, reason: "proposal-declined" });
    }
    res.json({ proposal: updated });
  } catch (err) {
    next(err);
  }
}

async function cancelEventRequest(req, res, next) {
  try {
    const request = await prisma.eventRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "Event request not found." });
    if (request.customerId !== req.user.id) return res.status(403).json({ error: "You do not own this event request." });
    if (request.status !== "OPEN") return res.status(400).json({ error: "Only an open request can be cancelled." });

    await prisma.$transaction([
      prisma.eventRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }),
      prisma.eventProposal.updateMany({ where: { eventRequestId: request.id, status: "PENDING" }, data: { status: "WITHDRAWN" } }),
    ]);
    req.app.get("io")?.to("dispatch:eventplanners").emit("event-request:updated", { requestId: request.id, reason: "cancelled" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { createEventRequest, listEventRequests, getEventRequest, submitProposal, acceptProposal, declineProposal, cancelEventRequest };
