const prisma = require("../config/db");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const commissionSvc = require("../services/commission.service");
const { logAdminAction } = require("../services/auditLog.service");
const { notify, notifyAllAdmins } = require("../services/notifications.service");
const { closeSupportThreadForContext } = require("./chat.controller");

async function createTicket(req, res, next) {
  try {
    const { context, category, description, contextId, isDispute, requestedRefundKobo } = req.body;
    if (!context || !category) return res.status(400).json({ error: "context and category are required." });

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        context,
        category,
        description,
        contextId,
        isDispute: !!isDispute,
        requestedRefundKobo: requestedRefundKobo != null ? Number(requestedRefundKobo) : null,
      },
    });
    if (isDispute) {
      notifyAllAdmins(req.app.get("io"), "⚠️ New dispute", `${req.user.name || "A user"} opened a dispute: ${category}.`, { ticketId: ticket.id }).catch(() => {});
    }
    res.status(201).json({ ticket });
  } catch (err) {
    next(err);
  }
}

// Attaches one evidence photo to an already-created ticket — a separate
// step (rather than folding into createTicket) so the common non-dispute
// report stays a plain JSON POST, matching how KYC document upload is
// split from the rest of profile creation.
async function uploadEvidence(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    if (ticket.userId !== req.user.id) return res.status(403).json({ error: "You do not have access to this ticket." });

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { evidenceUrl: `/uploads/${req.file.filename}` },
    });
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
}

// Real party-relationship check for "the other side" of a dispute —
// shared by uploadSecondPartyEvidence and respondToTicket. Previously only
// BOOKING-context tickets verified the responder was actually the
// booking's vendor/customer; every other context (SHOP_SESSION included,
// a real live dispute path) only checked "isn't the original filer,"
// meaning any authenticated user could inject a fake counter-response or
// evidence photo onto someone else's dispute by guessing/enumerating a
// ticket id.
async function assertIsDisputeCounterparty(ticket, reqUser) {
  if (ticket.userId === reqUser.id) {
    throw Object.assign(new Error("You already filed this ticket — this is for the other party's response."), { status: 403 });
  }
  if (ticket.context === "BOOKING" && ticket.contextId) {
    const booking = await prisma.booking.findUnique({ where: { id: ticket.contextId }, select: { customerId: true, vendorId: true } });
    const isVendorSide = reqUser.vendorProfile && booking && booking.vendorId === reqUser.vendorProfile.id;
    const isCustomerSide = booking && booking.customerId === reqUser.id;
    if (!isVendorSide && !isCustomerSide) {
      throw Object.assign(new Error("You are not a party to this booking's dispute."), { status: 403 });
    }
    return;
  }
  if (ticket.context === "SHOP_SESSION" && ticket.contextId) {
    const session = await prisma.shopSession.findUnique({ where: { id: ticket.contextId }, select: { customerId: true, shopperId: true, riderId: true } });
    const isCustomerSide = session && session.customerId === reqUser.id;
    const isShopperSide = session && reqUser.shopperProfile && session.shopperId === reqUser.shopperProfile.id;
    const isRiderSide = session && reqUser.riderProfile && session.riderId === reqUser.riderProfile.id;
    if (!isCustomerSide && !isShopperSide && !isRiderSide) {
      throw Object.assign(new Error("You are not a party to this session's dispute."), { status: 403 });
    }
    return;
  }
  throw Object.assign(new Error("Counter-responses aren't supported for this ticket's context."), { status: 403 });
}

// Lets the counter-disputing party (e.g. the vendor responding to a
// customer's dispute) attach their own evidence photo -- previously only
// the original filer had a real evidence field (evidenceUrl); the other
// side had text only, no way to actually prove their claim.
async function uploadSecondPartyEvidence(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    await assertIsDisputeCounterparty(ticket, req.user);

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { secondPartyEvidenceUrl: `/uploads/${req.file.filename}` },
    });
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
}

// The vendor's real userId for a ticket, if one exists -- prefers the
// already-recorded secondPartyUserId (set once the vendor has actually
// responded), but for a BOOKING-context ticket (the normal case for the
// new booking dispute flow) resolves it straight from the booking so
// admin's "Chat Vendor" entry point is available from the moment the
// ticket is filed, not only after the vendor has already replied.
async function resolveVendorUserIdForTicket(ticket) {
  if (ticket.secondPartyUserId) return ticket.secondPartyUserId;
  if (ticket.context === "BOOKING" && ticket.contextId) {
    const booking = await prisma.booking.findUnique({ where: { id: ticket.contextId }, include: { vendor: { select: { userId: true } } } });
    return booking?.vendor?.userId || null;
  }
  return null;
}

// The real amount currently held/disputed for a ticket's context — lets
// the admin panel pre-fill a refund amount instead of the admin having to
// know/type it blind.
async function sumHeldAmountForTicket(ticket) {
  const where = escrowHoldWhereForTicket(ticket);
  if (!where) return 0;
  const holds = await prisma.escrowHold.findMany({ where: { ...where, status: { in: ["HELD", "DISPUTED"] } } });
  return holds.reduce((sum, h) => sum + h.amountKobo, 0);
}

async function listMyTickets(req, res, next) {
  try {
    const tickets = await prisma.supportTicket.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
}

async function getTicket(req, res, next) {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    if (ticket.userId !== req.user.id && req.user.role !== "ADMIN") return res.status(403).json({ error: "You do not have access to this ticket." });
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

// Admin-only: triage queue for support staff.
async function listAllTickets(req, res, next) {
  try {
    const { status } = req.query;
    const tickets = await prisma.supportTicket.findMany({
      where: { ...(status && { status }) },
      include: { user: { select: { name: true, phone: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    const withAmounts = await Promise.all(
      tickets.map(async (t) => ({ ...t, heldAmountKobo: t.isDispute ? await sumHeldAmountForTicket(t) : 0, vendorUserId: t.isDispute ? await resolveVendorUserIdForTicket(t) : null }))
    );
    res.json({ tickets: withAmounts });
  } catch (err) {
    next(err);
  }
}

function escrowHoldWhereForTicket(ticket) {
  if (ticket.context === "BOOKING" && ticket.contextId) return { status: "HELD", bookingId: ticket.contextId };
  if (ticket.context === "SHOP_SESSION" && ticket.contextId) return { status: "HELD", shopSessionId: ticket.contextId };
  return null;
}

// { contextType, bookingId, shopSessionId } shaped for escrow.service.js's
// resolveDisputedHoldsForContext/releaseAllHoldsForContext, from a ticket's
// own context/contextId — used by the resolution branch below.
function escrowContextForTicket(ticket) {
  if (ticket.context === "BOOKING" && ticket.contextId) return { contextType: "BOOKING", bookingId: ticket.contextId };
  if (ticket.context === "SHOP_SESSION" && ticket.contextId) return { contextType: "SHOP_SESSION", shopSessionId: ticket.contextId };
  return null;
}

async function updateTicketStatus(req, res, next) {
  try {
    const { status, resolution, refundAmountKobo } = req.body;
    if (!["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(status)) return res.status(400).json({ error: "Invalid status." });

    const existing = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Ticket not found." });

    // Opening an investigation on a dispute pulls any still-held escrow
    // for that context out of the auto-release sweep, so a vendor/rider
    // doesn't get paid out while the claim is being looked into.
    if (status === "IN_PROGRESS" && existing.isDispute) {
      const holdWhere = escrowHoldWhereForTicket(existing);
      if (holdWhere) {
        const holds = await prisma.escrowHold.findMany({ where: holdWhere });
        for (const hold of holds) await escrow.disputeHold(hold.id);
      }
    }

    const data = { status, resolution, resolvedAt: ["RESOLVED", "CLOSED"].includes(status) ? new Date() : null };

    // A platform-funded credit for the admin's exact decided amount —
    // not an automatic full-hold refund, since a partial refund is a
    // real possibility and nothing is clawed back from a vendor/rider
    // who may have already been paid out.
    if (refundAmountKobo != null && Number(refundAmountKobo) > 0) {
      await walletSvc.creditWallet(existing.userId, Number(refundAmountKobo), "ADJUSTMENT", {
        description: `Dispute refund — ${resolution || existing.category}`,
      });
      data.refundAmountKobo = Number(refundAmountKobo);
      data.refundedAt = new Date();
    }

    // Actually moves the real money for a resolved dispute — this used to
    // silently no-op: any hold this ticket disputed (via the IN_PROGRESS
    // step above) is DISPUTED, not HELD, so releaseAllHoldsForContext's
    // HELD-only filter found nothing while the booking still got marked
    // COMPLETED, leaving the vendor's money frozen forever. Now generalized
    // to BOOKING and SHOP_SESSION contexts (a shop-session dispute
    // previously had no resolution path at all).
    if (status === "RESOLVED" && existing.isDispute) {
      const escrowCtx = escrowContextForTicket(existing);
      if (escrowCtx) {
        // Booking-context disputes need the real booking (vendor/type/total/
        // customer) to notify both sides and, for Event Planner specifically,
        // to charge the 10% commission that would otherwise never happen --
        // EP has no escrow hold to release, so the generic
        // releaseAllHoldsForContext/resolveDisputedHoldsForContext calls
        // below are a safe no-op for it and nothing else here used to charge
        // its commission on the dispute path (only the non-disputed
        // confirmBookingCompletion happy path did).
        const booking =
          escrowCtx.contextType === "BOOKING"
            ? await prisma.booking.findUnique({ where: { id: escrowCtx.bookingId }, include: { vendor: { select: { id: true, userId: true } } } })
            : null;

        if (!data.refundAmountKobo) {
          // No refund issued — the payee's side (vendor/rider/shopper) won.
          // Release BOTH any hold still genuinely HELD (a ticket resolved
          // without ever going through "Investigate") and any DISPUTED one.
          const opts = { description: `Dispute resolved in the payee's favor — ${resolution || "admin decision"}` };
          await escrow.releaseAllHoldsForContext(escrowCtx, opts);
          await escrow.resolveDisputedHoldsForContext(escrowCtx, "RELEASE", opts);
          if (escrowCtx.contextType === "BOOKING") {
            await prisma.booking.update({ where: { id: escrowCtx.bookingId }, data: { status: "COMPLETED", completedAt: new Date() } }).catch(() => {});
            if (booking && booking.type === "EVENT_PLANNING") {
              await commissionSvc.addBookingCommission(booking.vendorId, booking.totalKobo);
            }
          } else {
            await prisma.shopSession.update({ where: { id: escrowCtx.shopSessionId }, data: { status: "COMPLETED", completedAt: new Date() } }).catch(() => {});
          }
          if (booking) {
            const vendorMsg =
              booking.type === "EVENT_PLANNING"
                ? `The dispute on the booking #${booking.bookingNumber} was resolved in your favor; Escrow has released your payment.<br>Your 10% platform commission for it is now due on your dashboard. — ₦${Math.round(booking.totalKobo / 100).toLocaleString()}.`
                : `The dispute on the booking #${booking.bookingNumber} was resolved in your favor; Escrow has released your payment.<br>₦${Math.round(booking.totalKobo / 100).toLocaleString()}.`;
            await notify(req.app.get("io"), booking.vendor.userId, "ORDER_UPDATE", "Dispute resolved", vendorMsg, { bookingId: booking.id }).catch(() => {});
            await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Dispute resolved", `The dispute on the booking #${booking.bookingNumber} was resolved in the vendor's favor.`, { bookingId: booking.id }).catch(() => {});
          }
        } else {
          // A refund was already paid out above as a real ADJUSTMENT wallet
          // credit (which may be a partial amount, different from the sum
          // of held funds) — close out the disputed holds without crediting
          // again (skipCredit), so they don't stay stuck in DISPUTED forever.
          await escrow.resolveDisputedHoldsForContext(escrowCtx, "REFUND", {
            description: `Dispute resolved in the filer's favor — ${resolution || "admin decision"}`,
            skipCredit: true,
          });
          if (escrowCtx.contextType === "BOOKING") {
            await prisma.booking.update({ where: { id: escrowCtx.bookingId }, data: { status: "CANCELLED", cancelledAt: new Date() } }).catch(() => {});
          }
          if (booking) {
            await notify(
              req.app.get("io"),
              booking.customerId,
              "ORDER_UPDATE",
              "Dispute resolved",
              `The dispute on the booking #${booking.bookingNumber} was resolved in favor of the customer as a refund.<br>₦${Math.round(Number(data.refundAmountKobo) / 100).toLocaleString()} was refunded to your wallet.`,
              { bookingId: booking.id }
            ).catch(() => {});
            await notify(req.app.get("io"), booking.vendor.userId, "ORDER_UPDATE", "Dispute resolved", `The dispute on the booking #${booking.bookingNumber} was resolved in the customer's favor.`, { bookingId: booking.id }).catch(() => {});
          }
        }
        if (escrowCtx.contextType === "BOOKING") closeSupportThreadForContext(escrowCtx.bookingId);
      }
    }

    const ticket = await prisma.supportTicket.update({ where: { id: existing.id }, data });
    if (existing.isDispute || data.refundAmountKobo) {
      await logAdminAction(
        req.user,
        "DISPUTE_RESOLVED",
        "SupportTicket",
        ticket.id,
        `Status → ${status}${data.refundAmountKobo ? `, refund ₦${Math.round(data.refundAmountKobo / 100)}` : ""}`
      );
    }
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

// Lets the OTHER party on a dispute (e.g. the vendor, when the customer
// filed the ticket) add their own side — one response, not a thread.
// Real party check now covers BOOKING and SHOP_SESSION contexts alike —
// see assertIsDisputeCounterparty.
async function respondToTicket(req, res, next) {
  try {
    const { response } = req.body;
    if (!response || !response.trim()) return res.status(400).json({ error: "response is required." });

    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    if (ticket.secondPartyResponse) return res.status(409).json({ error: "A response has already been added to this ticket." });
    await assertIsDisputeCounterparty(ticket, req.user);

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { secondPartyResponse: response.trim(), secondPartyRespondedAt: new Date(), secondPartyUserId: req.user.id },
    });
    await notify(req.app.get("io"), ticket.userId, "ORDER_UPDATE", "Response added to your dispute", "The other party added their side of the story. An admin will review both and resolve it.", { ticketId: ticket.id }).catch(() => {});
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createTicket,
  uploadEvidence,
  uploadSecondPartyEvidence,
  listMyTickets,
  getTicket,
  listAllTickets,
  updateTicketStatus,
  respondToTicket,
  resolveVendorUserIdForTicket,
};
