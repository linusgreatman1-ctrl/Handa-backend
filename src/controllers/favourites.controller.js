const prisma = require("../config/db");

// One model covers cooks, event planners (VendorProfile, distinguished by
// vtype) and shoppers — see schema.prisma's Favourite model. Toggling is
// idempotent (unique constraint on userId+targetType+targetId) so the
// frontend doesn't need to track exact favourited state before calling.

async function addFavourite(req, res, next) {
  try {
    const { targetType, targetId } = req.body;
    if (!["VENDOR", "SHOPPER"].includes(targetType) || !targetId) {
      return res.status(400).json({ error: "targetType (VENDOR|SHOPPER) and targetId are required." });
    }
    const favourite = await prisma.favourite.upsert({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } },
      update: {},
      create: { userId: req.user.id, targetType, targetId },
    });
    res.status(201).json({ favourite });
  } catch (err) {
    next(err);
  }
}

async function removeFavourite(req, res, next) {
  try {
    const { targetType, targetId } = req.params;
    await prisma.favourite.deleteMany({ where: { userId: req.user.id, targetType, targetId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function listFavourites(req, res, next) {
  try {
    const favourites = await prisma.favourite.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });

    const vendorIds = favourites.filter((f) => f.targetType === "VENDOR").map((f) => f.targetId);
    const shopperIds = favourites.filter((f) => f.targetType === "SHOPPER").map((f) => f.targetId);

    const [vendors, shoppers] = await Promise.all([
      vendorIds.length
        ? prisma.vendorProfile.findMany({
            where: { id: { in: vendorIds } },
            select: { id: true, bizName: true, vtype: true, emoji: true, ratingAvg: true, ratingCount: true },
          })
        : [],
      shopperIds.length
        ? prisma.shopperProfile.findMany({
            where: { id: { in: shopperIds } },
            select: { id: true, market: true, ratingAvg: true, ratingCount: true, user: { select: { name: true, avatarUrl: true } } },
          })
        : [],
    ]);
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    const shopperById = new Map(shoppers.map((s) => [s.id, s]));

    const results = favourites
      .map((f) => {
        const target = f.targetType === "VENDOR" ? vendorById.get(f.targetId) : shopperById.get(f.targetId);
        if (!target) return null; // target was deleted since favouriting
        return { id: f.id, targetType: f.targetType, targetId: f.targetId, createdAt: f.createdAt, target };
      })
      .filter(Boolean);

    res.json({ favourites: results });
  } catch (err) {
    next(err);
  }
}

module.exports = { addFavourite, removeFavourite, listFavourites };
