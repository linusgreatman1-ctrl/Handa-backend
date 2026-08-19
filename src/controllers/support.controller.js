const prisma = require("../config/db");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const { logAdminAction } = require("../services/auditLog.service");

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
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
}

function escrowHoldWhereForTicket(ticket) {
  if (ticket.context === "ORDER" && ticket.contextId) return { status: "HELD", orderId: ticket.contextId };
  if (ticket.context === "BOOKING" && ticket.contextId) return { status: "HELD", bookingId: ticket.contextId };
  if (ticket.context === "SHOP_SESSION" && ticket.contextId) return { status: "HELD", shopSessionId: ticket.contextId };
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

module.exports = { createTicket, uploadEvidence, listMyTickets, getTicket, listAllTickets, updateTicketStatus };
