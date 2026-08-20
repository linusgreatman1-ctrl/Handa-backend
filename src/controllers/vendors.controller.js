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

async function createMenuItem(req, res, next) {
  try {
    const { name, description, emoji, imageUrl, category, unit, priceKobo, prepTimeMinutes, deliveryDays, popular } = req.body;
    if (!name || priceKobo === undefined) return res.status(400).json({ error: "name and priceKobo are required." });

    const item = await prisma.menuItem.create({
      data: {
        vendorId: req.user.vendorProfile.id,
        name,
        description,
        emoji,
        imageUrl,
        category,
        unit,
        priceKobo,
        prepTimeMinutes,
        deliveryDays,
        popular: !!popular,
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

    const { name, description, emoji, imageUrl, category, unit, priceKobo, prepTimeMinutes, deliveryDays, popular, inStock } = req.body;
    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(emoji !== undefined && { emoji }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(category !== undefined && { category }),
        ...(unit !== undefined && { unit }),
        ...(priceKobo !== undefined && { priceKobo }),
        ...(prepTimeMinutes !== undefined && { prepTimeMinutes }),
        ...(deliveryDays !== undefined && { deliveryDays }),
        ...(popular !== undefined && { popular }),
        ...(inStock !== undefined && { inStock }),
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

async function createServicePackage(req, res, next) {
  try {
    const { key, label, priceKobo, includes } = req.body;
    if (!key || !label || priceKobo === undefined) return res.status(400).json({ error: "key, label, and priceKobo are required." });
    const pkg = await prisma.servicePackage.create({
      data: { vendorId: req.user.vendorProfile.id, key, label, priceKobo, includes: Array.isArray(includes) ? includes : [] },
    });
    res.status(201).json({ package: pkg });
  } catch (err) {
    next(err);
  }
}

async function updateServicePackage(req, res, next) {
  try {
    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.pkgId } });
    if (!pkg || pkg.vendorId !== req.user.vendorProfile.id) return res.status(404).json({ error: "Package not found." });
    const { label, priceKobo, includes } = req.body;
    const updated = await prisma.servicePackage.update({
      where: { id: req.params.pkgId },
      data: {
        ...(label !== undefined && { label }),
        ...(priceKobo !== undefined && { priceKobo }),
        ...(includes !== undefined && { includes }),
      },
    });
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
    if (!["HOME_COOK", "EVENT_PLANNER"].includes(req.user.vendorProfile.vtype)) {
      return res.status(400).json({ error: "Commission periods only apply to home cook and event planner accounts." });
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
