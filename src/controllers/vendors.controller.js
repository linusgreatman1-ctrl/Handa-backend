const prisma = require("../config/db");
const commissionSvc = require("../services/commission.service");

// One listing endpoint backs the Home Cooks and Event Planners catalog
// tabs in the frontend — they're all VendorProfile rows, filtered by vtype.
async function listVendors(req, res, next) {
  try {
    const { vtype, state, tag, q, online } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, parseInt(req.query.pageSize) || 20);

    const where = {
      ...(vtype && { vtype }),
      ...(online === "true" && { isOnline: true }),
      ...(tag && { tags: { has: tag } }),
      ...(q && { bizName: { contains: q, mode: "insensitive" } }),
      ...(state && { user: { state } }),
    };

    const [vendors, total] = await Promise.all([
      prisma.vendorProfile.findMany({
        where,
        include: { user: { select: { name: true, address: true, state: true, lga: true, avatarUrl: true } } },
        orderBy: [{ featuredUntil: "desc" }, { ratingAvg: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.vendorProfile.count({ where }),
    ]);

    res.json({ vendors, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

async function getVendor(req, res, next) {
  try {
    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, address: true, state: true, lga: true, avatarUrl: true, phone: true } },
        menuItems: { orderBy: [{ popular: "desc" }, { name: "asc" }] },
        servicePackages: true,
      },
    });
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });
    res.json({ vendor });
  } catch (err) {
    next(err);
  }
}

async function getMyVendor(req, res, next) {
  try {
    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: req.user.vendorProfile.id },
      include: { menuItems: true, servicePackages: true },
    });
    res.json({ vendor });
  } catch (err) {
    next(err);
  }
}

// Computed live from real Booking rows rather than a stored/stale field --
// VendorProfile has no acceptRate/bookingsCount column (and RiderProfile's
// own acceptRate, while stored, is never actually written anywhere in this
// codebase either -- it's seed-only). Mirrors the same "compute on demand"
// pattern users.controller.js's getMyStats already uses for customers.
async function getMyVendorStats(req, res, next) {
  try {
    const vendorId = req.user.vendorProfile.id;
    const [bookingsCount, decidedCount, declinedCount] = await Promise.all([
      prisma.booking.count({ where: { vendorId, status: "COMPLETED" } }),
      prisma.booking.count({ where: { vendorId, status: { in: ["DECLINED", "CONFIRMED", "COMPLETED", "CANCELLED"] } } }),
      prisma.booking.count({ where: { vendorId, status: "DECLINED" } }),
    ]);
    const acceptRate = decidedCount > 0 ? Math.round(((decidedCount - declinedCount) / decidedCount) * 100) : null;
    res.json({ bookingsCount, acceptRate });
  } catch (err) {
    next(err);
  }
}

// ── Menu items (home cook specials) ──

async function listMenuItems(req, res, next) {
  try {
    const items = await prisma.menuItem.findMany({
      where: { vendorId: req.params.id, ...(req.query.category && { category: req.query.category }) },
      orderBy: [{ popular: "desc" }, { name: "asc" }],
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
}

// CATERING only -- every dish a caterer assigns to one of their own package
// tiers (MenuItem.packageTier, the ServicePackage's own .key lowercased, or
// a CUSTOM package's id) must be priced inside that tier's own declared
// per-head range (ServicePackage.minPriceKobo/maxPriceKobo). The customer
// already sees that range on the catalog card before ever picking a tier
// (see renderCatering, public/app/index.html) -- letting a dish quietly
// exceed it would make that range a lie. Returns an error string, or null
// if the price is fine (or nothing needs checking).
async function _validateCateringTierPrice(vendorId, vtype, packageTier, priceKobo) {
  if (vtype !== "CATERING" || !packageTier) return null;
  const pkg = await prisma.servicePackage.findFirst({
    where: {
      vendorId,
      OR: [{ id: packageTier }, { key: packageTier.toUpperCase() }],
    },
  });
  if (!pkg) return "That package no longer exists -- pick another tier.";
  if (pkg.minPriceKobo == null || pkg.maxPriceKobo == null) {
    return `Set a per-head price range on "${pkg.label}" first, before adding dishes to it.`;
  }
  if (priceKobo < pkg.minPriceKobo || priceKobo > pkg.maxPriceKobo) {
    const min = Math.round(pkg.minPriceKobo / 100).toLocaleString();
    const max = Math.round(pkg.maxPriceKobo / 100).toLocaleString();
    return `This dish's price must be between ₦${min} and ₦${max}/head to match the "${pkg.label}" package's own range.`;
  }
  return null;
}

async function createMenuItem(req, res, next) {
  try {
    const { name, description, emoji, imageUrl, category, priceKobo, prepTimeMinutes, popular, leadTimeNote, packageTier } = req.body;
    if (!name || priceKobo === undefined) return res.status(400).json({ error: "name and priceKobo are required." });

    const vtype = req.user.vendorProfile.vtype;
    const tierError = await _validateCateringTierPrice(req.user.vendorProfile.id, vtype, packageTier, Number(priceKobo));
    if (tierError) return res.status(400).json({ error: tierError });

    const item = await prisma.menuItem.create({
      data: {
        vendorId: req.user.vendorProfile.id,
        name,
        description,
        emoji,
        imageUrl,
        category,
        priceKobo,
        prepTimeMinutes,
        popular: !!popular,
        leadTimeNote: leadTimeNote || null,
        packageTier: vtype === "CATERING" ? packageTier || null : null,
      },
    });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
}

async function updateMenuItem(req, res, next) {
  try {
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Menu item not found." });

    const { name, description, emoji, imageUrl, category, priceKobo, prepTimeMinutes, popular, inStock, leadTimeNote, packageTier } = req.body;
    const vtype = req.user.vendorProfile.vtype;
    const nextTier = packageTier !== undefined ? packageTier : item.packageTier;
    const nextPrice = priceKobo !== undefined ? Number(priceKobo) : item.priceKobo;
    const tierError = await _validateCateringTierPrice(req.user.vendorProfile.id, vtype, nextTier, nextPrice);
    if (tierError) return res.status(400).json({ error: tierError });

    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(emoji !== undefined && { emoji }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(category !== undefined && { category }),
        ...(priceKobo !== undefined && { priceKobo }),
        ...(prepTimeMinutes !== undefined && { prepTimeMinutes }),
        ...(popular !== undefined && { popular }),
        ...(inStock !== undefined && { inStock }),
        ...(leadTimeNote !== undefined && { leadTimeNote: leadTimeNote || null }),
        ...(packageTier !== undefined && vtype === "CATERING" && { packageTier: packageTier || null }),
      },
    });
    res.json({ item: updated });
  } catch (err) {
    next(err);
  }
}

async function uploadMenuItemPhoto(req, res, next) {
  try {
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Menu item not found." });
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const imageUrl = `/uploads/${req.file.filename}`;
    const updated = await prisma.menuItem.update({ where: { id: req.params.itemId }, data: { imageUrl } });
    res.json({ item: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteMenuItem(req, res, next) {
  try {
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Menu item not found." });
    await prisma.menuItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── Service packages (event planners: basic/standard/premium/…) ──

// CATERING packages are sold as a per-head price RANGE (min/max), not the
// single flat priceKobo Event Planner packages use -- min<=max and both
// positive, checked once here for both create and update.
function _validatePriceRange(minPriceKobo, maxPriceKobo) {
  if (minPriceKobo == null || maxPriceKobo == null) return "Both a minimum and maximum per-head price are required.";
  if (!(minPriceKobo > 0) || !(maxPriceKobo > 0)) return "Prices must be greater than zero.";
  if (minPriceKobo > maxPriceKobo) return "The minimum price can't be higher than the maximum.";
  return null;
}

async function createServicePackage(req, res, next) {
  try {
    const { key, label, priceKobo, includes, guestCount, minPriceKobo, maxPriceKobo } = req.body;
    if (!key || !label) return res.status(400).json({ error: "key and label are required." });
    const isCatering = req.user.vendorProfile.vtype === "CATERING";
    let data = { vendorId: req.user.vendorProfile.id, key, label, includes: Array.isArray(includes) ? includes : [] };
    if (isCatering) {
      const min = minPriceKobo !== undefined && minPriceKobo !== null && minPriceKobo !== "" ? Number(minPriceKobo) : null;
      const max = maxPriceKobo !== undefined && maxPriceKobo !== null && maxPriceKobo !== "" ? Number(maxPriceKobo) : null;
      const rangeError = _validatePriceRange(min, max);
      if (rangeError) return res.status(400).json({ error: rangeError });
      data = { ...data, minPriceKobo: min, maxPriceKobo: max, priceKobo: min, guestCount: null };
    } else {
      if (priceKobo === undefined) return res.status(400).json({ error: "priceKobo is required." });
      data = { ...data, priceKobo, guestCount: guestCount !== undefined && guestCount !== null && guestCount !== "" ? parseInt(guestCount) : null };
    }
    const pkg = await prisma.servicePackage.create({ data });
    res.status(201).json({ package: pkg });
  } catch (err) {
    next(err);
  }
}

async function updateServicePackage(req, res, next) {
  try {
    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.pkgId } });
    if (!pkg || pkg.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Package not found." });
    const { label, priceKobo, includes, guestCount, minPriceKobo, maxPriceKobo } = req.body;
    const isCatering = req.user.vendorProfile.vtype === "CATERING";
    let data = {
      ...(label !== undefined && { label }),
      ...(includes !== undefined && { includes }),
    };
    if (isCatering) {
      const min = minPriceKobo !== undefined ? (minPriceKobo === null || minPriceKobo === "" ? null : Number(minPriceKobo)) : pkg.minPriceKobo;
      const max = maxPriceKobo !== undefined ? (maxPriceKobo === null || maxPriceKobo === "" ? null : Number(maxPriceKobo)) : pkg.maxPriceKobo;
      if (minPriceKobo !== undefined || maxPriceKobo !== undefined) {
        const rangeError = _validatePriceRange(min, max);
        if (rangeError) return res.status(400).json({ error: rangeError });
        data = { ...data, minPriceKobo: min, maxPriceKobo: max, priceKobo: min };
      }
    } else {
      data = {
        ...data,
        ...(priceKobo !== undefined && { priceKobo }),
        ...(guestCount !== undefined && { guestCount: guestCount === null || guestCount === "" ? null : parseInt(guestCount) }),
      };
    }
    const updated = await prisma.servicePackage.update({ where: { id: req.params.pkgId }, data });
    res.json({ package: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteServicePackage(req, res, next) {
  try {
    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.pkgId } });
    if (!pkg || pkg.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Package not found." });
    await prisma.servicePackage.delete({ where: { id: req.params.pkgId } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getCurrentCommissionPeriod(req, res, next) {
  try {
    if (!["HOME_COOK", "EVENT_PLANNER", "CATERING", "CAKE"].includes(req.user.vendorProfile.vtype)) {
      return res.status(400).json({ error: "Commission periods only apply to home cook, event planner, catering, and cake accounts." });
    }
    const period = await commissionSvc.getOrCreateCurrentPeriod(req.user.vendorProfile.id);
    res.json({ period });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listVendors,
  getVendor,
  getMyVendor,
  getMyVendorStats,
  getCurrentCommissionPeriod,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  uploadMenuItemPhoto,
  deleteMenuItem,
  createServicePackage,
  updateServicePackage,
  deleteServicePackage,
};
