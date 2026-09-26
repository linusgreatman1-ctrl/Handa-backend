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

// A meal scoped to a package must be priced within that package's own
// advertised per-head range — the whole point of showing customers "Basic:
// ₦4,000-₦8,000/head" up front is that nothing they pick under it can cost
// more (or less) than that. Packages with no range set (Event Planner's
// lump-sum packages, or a Home Cook package created before this existed)
// impose no constraint. Returns a validated packageId (or null/undefined
// passthrough) or throws a 400.
async function resolveMenuItemPackage(packageId, vendorId, priceKobo) {
  if (packageId === undefined) return undefined;
  if (packageId === null || packageId === "") return null;
  const pkg = await prisma.servicePackage.findUnique({ where: { id: packageId } });
  if (!pkg || pkg.vendorId !== vendorId) throw Object.assign(new Error("Invalid package for this vendor."), { status: 400 });
  if (priceKobo !== undefined && pkg.priceMinKobo != null && pkg.priceMaxKobo != null) {
    if (priceKobo < pkg.priceMinKobo || priceKobo > pkg.priceMaxKobo) {
      const minN = Math.round(pkg.priceMinKobo / 100).toLocaleString();
      const maxN = Math.round(pkg.priceMaxKobo / 100).toLocaleString();
      throw Object.assign(new Error(`Price must be between ₦${minN} and ₦${maxN} per head for the ${pkg.label} package.`), { status: 400 });
    }
  }
  return packageId;
}

async function createMenuItem(req, res, next) {
  try {
    const { name, description, emoji, imageUrl, category, unit, priceKobo, prepTimeMinutes, deliveryDays, popular, contents, packageId } = req.body;
    if (!name || priceKobo === undefined) return res.status(400).json({ error: "name and priceKobo are required." });

    const resolvedPackageId = await resolveMenuItemPackage(packageId, req.user.vendorProfile.id, priceKobo);

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
        contents: Array.isArray(contents) ? contents : [],
        packageId: resolvedPackageId || null,
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

    const { name, description, emoji, imageUrl, category, unit, priceKobo, prepTimeMinutes, deliveryDays, popular, inStock, contents, packageId } = req.body;
    const effectivePackageId = packageId !== undefined ? packageId : item.packageId;
    const effectivePriceKobo = priceKobo !== undefined ? priceKobo : item.priceKobo;
    const resolvedPackageId = await resolveMenuItemPackage(effectivePackageId, req.user.vendorProfile.id, effectivePriceKobo);

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
        ...(contents !== undefined && { contents: Array.isArray(contents) ? contents : [] }),
        ...(packageId !== undefined && { packageId: resolvedPackageId || null }),
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

// ── Service packages: fixed-tier or CUSTOM, sold by either vendor type.
// Event Planner packages are typically a single lump-sum priceKobo for a
// fixed-scope job (guestCount caps it); Home Cook packages instead set
// priceMinKobo/priceMaxKobo, a per-head range the meals under them (see
// createMenuItem/updateMenuItem above) must stay inside. ──

function validatePriceRange(priceMinKobo, priceMaxKobo) {
  const hasMin = priceMinKobo !== undefined && priceMinKobo !== null && priceMinKobo !== "";
  const hasMax = priceMaxKobo !== undefined && priceMaxKobo !== null && priceMaxKobo !== "";
  if (!hasMin && !hasMax) return { priceMinKobo: null, priceMaxKobo: null };
  if (!hasMin || !hasMax) throw Object.assign(new Error("Provide both a minimum and maximum price per head."), { status: 400 });
  const min = parseInt(priceMinKobo);
  const max = parseInt(priceMaxKobo);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    throw Object.assign(new Error("Price range must be positive numbers."), { status: 400 });
  }
  if (min > max) throw Object.assign(new Error("Minimum price can't be higher than the maximum."), { status: 400 });
  return { priceMinKobo: min, priceMaxKobo: max };
}

async function createServicePackage(req, res, next) {
  try {
    const { key, label, priceKobo, includes, guestCount, priceMinKobo, priceMaxKobo } = req.body;
    if (!key || !label || priceKobo === undefined) return res.status(400).json({ error: "key, label, and priceKobo are required." });
    const range = validatePriceRange(priceMinKobo, priceMaxKobo);
    const pkg = await prisma.servicePackage.create({
      data: {
        vendorId: req.user.vendorProfile.id,
        key,
        label,
        priceKobo,
        ...range,
        includes: Array.isArray(includes) ? includes : [],
        guestCount: guestCount !== undefined && guestCount !== null && guestCount !== "" ? parseInt(guestCount) : null,
      },
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
    const { label, priceKobo, includes, guestCount, priceMinKobo, priceMaxKobo } = req.body;

    let range;
    if (priceMinKobo !== undefined || priceMaxKobo !== undefined) {
      range = validatePriceRange(priceMinKobo, priceMaxKobo);
      // Narrowing the range out from under meals customers already see
      // listed under this package would silently make an existing meal's
      // price fall outside what the package now advertises -- reject
      // instead, same as createMenuItem/updateMenuItem would refuse a new
      // meal in that position.
      if (range.priceMinKobo != null) {
        const outOfRange = await prisma.menuItem.findFirst({
          where: { packageId: pkg.id, OR: [{ priceKobo: { lt: range.priceMinKobo } }, { priceKobo: { gt: range.priceMaxKobo } }] },
        });
        if (outOfRange) {
          return res.status(400).json({ error: `"${outOfRange.name}" is priced outside this new range — update or unlink it from this package first.` });
        }
      }
    }

    const updated = await prisma.servicePackage.update({
      where: { id: req.params.pkgId },
      data: {
        ...(label !== undefined && { label }),
        ...(priceKobo !== undefined && { priceKobo }),
        ...(range && range),
        ...(includes !== undefined && { includes }),
        ...(guestCount !== undefined && { guestCount: guestCount === null || guestCount === "" ? null : parseInt(guestCount) }),
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
