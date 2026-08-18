const prisma = require("../config/db");

async function createTicket(req, res, next) {
  try {
    const { context, category, description, contextId } = req.body;
    if (!context || !category) return res.status(400).json({ error: "context and category are required." });

    const ticket = await prisma.supportTicket.create({
      data: { userId: req.user.id, context, category, description, contextId },
    });
    res.status(201).json({ ticket });
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

async function updateTicketStatus(req, res, next) {
  try {
    const { status, resolution } = req.body;
    if (!["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const ticket = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { status, resolution, resolvedAt: ["RESOLVED", "CLOSED"].includes(status) ? new Date() : null },
    });
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

module.exports = { createTicket, listMyTickets, getTicket, listAllTickets, updateTicketStatus };
