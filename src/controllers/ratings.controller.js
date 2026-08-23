const prisma = require("../config/db");

// The customer rates the vendor per booking, or the shopper/rider per
// Shop-For-Me session. Ratee is resolved server-side from the context,
// never trusted from the client, so a customer can't rate an arbitrary
// user.
async function resolveContextAndRatee(contextType, contextId, rateeRole, raterId) {
  if (contextType === "BOOKING") {
    const booking = await prisma.booking.findUnique({ where: { id: contextId }, include: { vendor: true } });
    if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404 });
    if (booking.customerId !== raterId) throw Object.assign(new Error("Only the customer on this booking can rate it."), { status: 403 });
    if (rateeRole !== "VENDOR") throw Object.assign(new Error("Invalid rateeRole for a booking."), { status: 400 });
    return { rateeId: booking.vendor.userId, field: { bookingId: booking.id } };
  }

  if (contextType === "SHOP_SESSION") {
    const session = await prisma.shopSession.findUnique({ where: { id: contextId }, include: { shopper: true, rider: true } });
    if (!session) throw Object.assign(new Error("Shop session not found."), { status: 404 });
    if (session.customerId !== raterId) throw Object.assign(new Error("Only the customer on this session can rate it."), { status: 403 });
    if (rateeRole === "SHOPPER") {
      if (!session.shopper) throw Object.assign(new Error("This session had no shopper."), { status: 400 });
      return { rateeId: session.shopper.userId, field: { shopSessionId: session.id } };
    }
    if (rateeRole === "RIDER") {
      if (!session.rider) throw Object.assign(new Error("This session had no rider."), { status: 400 });
      return { rateeId: session.rider.userId, field: { shopSessionId: session.id } };
    }
    throw Object.assign(new Error("Invalid rateeRole for a shop session."), { status: 400 });
  }

  throw Object.assign(new Error("Invalid contextType."), { status: 400 });
}

// Recomputes the ratee's aggregate rating (avg + count) on their role
// profile — this is what the vendor/rider/shopper cards' star rating
// actually reads, not a live join over every Rating row.
async function refreshRateeAggregate(rateeId, rateeRole) {
  const agg = await prisma.rating.aggregate({ where: { rateeId, rateeRole }, _avg: { score: true }, _count: true });
  const ratingAvg = agg._avg.score || 0;
  const ratingCount = agg._count;

  if (rateeRole === "VENDOR") {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId: rateeId } });
    if (profile) await prisma.vendorProfile.update({ where: { id: profile.id }, data: { ratingAvg, ratingCount } });
  } else if (rateeRole === "RIDER") {
    const profile = await prisma.riderProfile.findUnique({ where: { userId: rateeId } });
    if (profile) await prisma.riderProfile.update({ where: { id: profile.id }, data: { ratingAvg, ratingCount } });
  } else if (rateeRole === "SHOPPER") {
    const profile = await prisma.shopperProfile.findUnique({ where: { userId: rateeId } });
    if (profile) await prisma.shopperProfile.update({ where: { id: profile.id }, data: { ratingAvg, ratingCount } });
  }
}

async function createRating(req, res, next) {
  try {
    const { contextType, contextId, rateeRole, score, comment } = req.body;
    if (!contextType || !contextId || !rateeRole || !score) return res.status(400).json({ error: "contextType, contextId, rateeRole, and score are required." });
    if (score < 1 || score > 5) return res.status(400).json({ error: "score must be between 1 and 5." });

    const { rateeId, field } = await resolveContextAndRatee(contextType, contextId, rateeRole, req.user.id);

    const rating = await prisma.rating.create({
      data: { contextType, ...field, raterId: req.user.id, rateeId, rateeRole, score, comment },
    });

    await refreshRateeAggregate(rateeId, rateeRole);
    res.status(201).json({ rating });
  } catch (err) {
    next(err);
  }
}

async function listRatingsForUser(req, res, next) {
  try {
    const ratings = await prisma.rating.findMany({
      where: { rateeId: req.params.userId },
      include: { rater: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ ratings });
  } catch (err) {
    next(err);
  }
}

// Ratings the caller has GIVEN (as rater) — distinct from listRatingsForUser
// above, which only ever shows ratings ABOUT a target. GET /users/me/stats
// already counts these (Rating.count({where:{raterId}})); this lists their
// actual content so the customer's own "Reviews" stat can be clickable.
async function listRatingsGivenByMe(req, res, next) {
  try {
    const ratings = await prisma.rating.findMany({
      where: { raterId: req.user.id },
      include: { ratee: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ ratings });
  } catch (err) {
    next(err);
  }
}

module.exports = { createRating, listRatingsForUser, listRatingsGivenByMe };
