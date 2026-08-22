// TEMPORARY: one-time HTTP-triggered cleanup, same reasoning as
// internalSeed.routes.js -- Render's free tier blocks external DB
// connections and one-off Job runs, so this can only be triggered from
// inside the deployed process itself. Gated by the same SEED_SECRET.
// Wipes every Booking/ShopSession/EventRequest (and everything that only
// exists to describe one of those: EscrowHold, Rating, booking/session
// dispute tickets, EventProposal via cascade, Notification) so testing
// starts from a clean slate, and resets the denormalized rating stats
// that would otherwise go stale once their underlying Rating rows are
// gone. Delete this file (and its mount in server.js) once no longer
// needed -- it is deliberately NOT a permanent feature.
const express = require("express");
const prisma = require("../config/db");

const router = express.Router();

router.get("/", async (req, res) => {
  if (!process.env.SEED_SECRET || req.query.key !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const [escrowHolds, ratings, tickets, eventRequests, shopSessions, bookings, notifications] = await prisma.$transaction([
      prisma.escrowHold.deleteMany({}),
      prisma.rating.deleteMany({}),
      prisma.supportTicket.deleteMany({ where: { context: { in: ["BOOKING", "SHOP_SESSION"] } } }),
      prisma.eventRequest.deleteMany({}), // cascades EventProposal
      prisma.shopSession.deleteMany({}), // cascades ShopSessionItem, SellerPayout
      prisma.booking.deleteMany({}),
      prisma.notification.deleteMany({}),
    ]);
    await prisma.$transaction([
      prisma.vendorProfile.updateMany({ data: { ratingAvg: 0, ratingCount: 0 } }),
      prisma.riderProfile.updateMany({ data: { ratingAvg: 0, ratingCount: 0 } }),
      prisma.shopperProfile.updateMany({ data: { ratingAvg: 0, ratingCount: 0 } }),
    ]);
    res.json({
      success: true,
      deleted: {
        escrowHolds: escrowHolds.count,
        ratings: ratings.count,
        bookingOrSessionDisputeTickets: tickets.count,
        eventRequests: eventRequests.count,
        shopSessions: shopSessions.count,
        bookings: bookings.count,
        notifications: notifications.count,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
