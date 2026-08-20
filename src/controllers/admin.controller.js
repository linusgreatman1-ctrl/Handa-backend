const prisma = require("../config/db");
const { logAdminAction } = require("../services/auditLog.service");

// Headline numbers for the admin panel's landing dashboard — cheap
// aggregate counts, not full row dumps.
async function dashboardStats(req, res, next) {
  try {
    const [usersByRole, bookingsByStatus, sessionsByStatus, openTickets, pendingWithdrawals, heldEscrow, bookingGmv, sessionGmv] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: true }),
      prisma.booking.groupBy({ by: ["status"], _count: true }),
      prisma.shopSession.groupBy({ by: ["status"], _count: true }),
      prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      prisma.withdrawal.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.escrowHold.aggregate({ where: { status: "HELD" }, _sum: { amountKobo: true } }),
      prisma.booking.aggregate({ where: { status: "COMPLETED" }, _sum: { totalKobo: true } }),
      prisma.shopSession.aggregate({ where: { status: "COMPLETED" }, _sum: { itemsTotalKobo: true, sessionFeeKobo: true } }),
    ]);

    res.json({
      usersByRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count])),
      bookingsByStatus: Object.fromEntries(bookingsByStatus.map((r) => [r.status, r._count])),
      shopSessionsByStatus: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r._count])),
      openTickets,
      pendingWithdrawals,
      heldEscrowKobo: heldEscrow._sum.amountKobo || 0,
      grossMerchandiseValueKobo:
        (bookingGmv._sum.totalKobo || 0) + (sessionGmv._sum.itemsTotalKobo || 0) + (sessionGmv._sum.sessionFeeKobo || 0),
    });
  } catch (err) {
    next(err);
  }
}

// Trend/breakdown reporting, separate from dashboardStats' current-snapshot
// counts. Day-bucketing and category-bucketing are done in JS rather than
// with raw SQL date-truncation — data volumes here are demo-scale, and it
// keeps every query as plain Prisma client calls like the rest of this
// file, no string-built SQL.
async function getReports(req, res, next) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [platformHolds, bookingRevenue, sessionRevenue, commissionByStatus, bookingRevenueByVendor] = await Promise.all([
      prisma.escrowHold.findMany({
        where: { payeeRole: "PLATFORM", status: "RELEASED", createdAt: { gte: thirtyDaysAgo } },
        select: { amountKobo: true, createdAt: true },
      }),
      prisma.booking.groupBy({ by: ["type"], _sum: { totalKobo: true }, where: { status: "COMPLETED" } }),
      prisma.shopSession.findMany({ where: { status: "COMPLETED" }, select: { itemsTotalKobo: true, sessionFeeKobo: true } }),
      prisma.commissionPeriod.groupBy({ by: ["status"], _sum: { amountDueKobo: true, amountPaidKobo: true } }),
      prisma.booking.groupBy({ by: ["vendorId"], _sum: { totalKobo: true }, where: { status: "COMPLETED" } }),
    ]);

    // ── Revenue by day (last 30 days, platform's own cut only) ──
    const dayTotals = {};
    platformHolds.forEach((h) => {
      const key = h.createdAt.toISOString().slice(0, 10);
      dayTotals[key] = (dayTotals[key] || 0) + h.amountKobo;
    });
    const revenueByDay = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      revenueByDay.push({ date: key, revenueKobo: dayTotals[key] || 0 });
    }

    // ── GMV by category ──
    const sessionGmv = sessionRevenue.reduce((sum, s) => sum + s.itemsTotalKobo + s.sessionFeeKobo, 0);
    const gmvByCategory = [
      ...bookingRevenue.map((b) => ({ category: b.type, gmvKobo: b._sum.totalKobo || 0 })),
      { category: "SHOP_FOR_ME", gmvKobo: sessionGmv },
    ].sort((a, b) => b.gmvKobo - a.gmvKobo);

    // ── Commission collection status ──
    const commissionSummary = Object.fromEntries(
      commissionByStatus.map((c) => [c.status, { dueKobo: c._sum.amountDueKobo || 0, paidKobo: c._sum.amountPaidKobo || 0 }])
    );

    // ── Top vendors by revenue ──
    const vendorTotals = {};
    bookingRevenueByVendor.forEach((r) => { vendorTotals[r.vendorId] = (vendorTotals[r.vendorId] || 0) + (r._sum.totalKobo || 0); });
    const topVendorIds = Object.entries(vendorTotals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
    const vendorNames = await prisma.vendorProfile.findMany({ where: { id: { in: topVendorIds } }, select: { id: true, bizName: true, vtype: true } });
    const vendorNameById = Object.fromEntries(vendorNames.map((v) => [v.id, v]));
    const topVendors = topVendorIds.map((id) => ({
      vendorId: id,
      bizName: vendorNameById[id]?.bizName || "Unknown",
      vtype: vendorNameById[id]?.vtype || "",
      revenueKobo: vendorTotals[id],
    }));

    res.json({ revenueByDay, gmvByCategory, commissionSummary, topVendors });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const { role, status, q, state } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 25);

    const where = {
      ...(role && { role }),
      ...(status && { status }),
      ...(state && { state }),
      ...(q && { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, role: true, status: true, state: true, lga: true, createdAt: true, lastLoginAt: true,
          vendorProfile: { select: { id: true, vtype: true, bizName: true, isVerified: true, isOnline: true } },
          riderProfile: { select: { id: true, isOnline: true, isVerified: true, ratingAvg: true, deliveries: true } },
          shopperProfile: { select: { id: true, isOnline: true, isVerified: true, ratingAvg: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

async function updateUserStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!["ACTIVE", "SUSPENDED", "DELETED"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot change your own account status." });

    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true, name: true, email: true } });
    if (!target) return res.status(404).json({ error: "User not found." });
    // Changing another admin's status is admin management, not routine
    // moderation — same rule the dedicated /admin/admins endpoints enforce.
    if (target.role === "ADMIN" && !req.user.isSuperAdmin) {
      return res.status(403).json({ error: "Only a super admin can change another admin's status." });
    }

    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
    await logAdminAction(req.user, "USER_STATUS_CHANGED", "User", user.id, `Set ${target.name} (${target.email || "no email"}) status to ${status}`);
    res.json({ user: { id: user.id, status: user.status } });
  } catch (err) {
    next(err);
  }
}

async function listVendorsForAdmin(req, res, next) {
  try {
    const { vtype, verified, state } = req.query;
    const vendors = await prisma.vendorProfile.findMany({
      where: {
        ...(vtype && { vtype }),
        ...(verified !== undefined && { isVerified: verified === "true" }),
        ...(state && { user: { state } }),
      },
      include: { user: { select: { id: true, name: true, email: true, phone: true, state: true, lga: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ vendors });
  } catch (err) {
    next(err);
  }
}

// Real "paid vs pending" money breakdown for one user — reuses the same
// aggregate shape wallet.controller.js's self-service getWallet computes
// for req.user.id, just parameterized for an arbitrary admin-viewed user.
// paidKobo = ever released into their wallet (Transaction type PAYOUT);
// pendingKobo = still locked in escrow awaiting release (EscrowHold where
// this user is the payee); totalWithdrawnKobo = already sent to their bank.
async function financeBreakdownForUser(userId) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  const walletId = wallet ? wallet.id : null;
  const [paidAgg, withdrawnAgg, pendingAgg] = await Promise.all([
    walletId ? prisma.transaction.aggregate({ where: { walletId, type: "PAYOUT" }, _sum: { amountKobo: true } }) : Promise.resolve({ _sum: { amountKobo: 0 } }),
    walletId ? prisma.transaction.aggregate({ where: { walletId, type: "WITHDRAWAL" }, _sum: { amountKobo: true } }) : Promise.resolve({ _sum: { amountKobo: 0 } }),
    prisma.escrowHold.aggregate({ where: { payeeId: userId, status: "HELD" }, _sum: { amountKobo: true } }),
  ]);
  return {
    balanceKobo: wallet ? wallet.balanceKobo : 0,
    paidKobo: paidAgg._sum.amountKobo || 0,
    pendingKobo: pendingAgg._sum.amountKobo || 0,
    totalWithdrawnKobo: Math.abs(withdrawnAgg._sum.amountKobo || 0),
  };
}

async function getVendorDetailForAdmin(req, res, next) {
  try {
    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, email: true, phone: true, address: true, state: true, lga: true, status: true, createdAt: true } } },
    });
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });
    const [kycDocuments, commissionPeriods, finance, menuItems, servicePackages] = await Promise.all([
      prisma.kycDocument.findMany({ where: { userId: vendor.user.id }, orderBy: { createdAt: "desc" } }),
      prisma.commissionPeriod.findMany({ where: { vendorId: vendor.id }, orderBy: { periodStart: "desc" } }),
      financeBreakdownForUser(vendor.user.id),
      prisma.menuItem.findMany({ where: { vendorId: vendor.id }, orderBy: { name: "asc" } }),
      prisma.servicePackage.findMany({ where: { vendorId: vendor.id }, orderBy: { label: "asc" } }),
    ]);
    res.json({ vendor, kycDocuments, commissionPeriods, finance, menuItems, servicePackages });
  } catch (err) {
    next(err);
  }
}

async function deleteMenuItemForAdmin(req, res, next) {
  try {
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: "Menu item not found." });
    await prisma.menuItem.delete({ where: { id: req.params.id } });
    logAdminAction(req.user, "MENU_ITEM_DELETED", "MenuItem", req.params.id, item.name);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function deleteServicePackageForAdmin(req, res, next) {
  try {
    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.id } });
    if (!pkg) return res.status(404).json({ error: "Package not found." });
    await prisma.servicePackage.delete({ where: { id: req.params.id } });
    logAdminAction(req.user, "SERVICE_PACKAGE_DELETED", "ServicePackage", req.params.id, pkg.label);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getRiderDetailForAdmin(req, res, next) {
  try {
    const rider = await prisma.riderProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, email: true, phone: true, address: true, state: true, lga: true, status: true, createdAt: true } } },
    });
    if (!rider) return res.status(404).json({ error: "Rider not found." });
    const [kycDocuments, finance] = await Promise.all([
      prisma.kycDocument.findMany({ where: { userId: rider.user.id }, orderBy: { createdAt: "desc" } }),
      financeBreakdownForUser(rider.user.id),
    ]);
    res.json({ rider, kycDocuments, finance });
  } catch (err) {
    next(err);
  }
}

async function getShopperDetailForAdmin(req, res, next) {
  try {
    const shopper = await prisma.shopperProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, email: true, phone: true, address: true, state: true, lga: true, status: true, createdAt: true } } },
    });
    if (!shopper) return res.status(404).json({ error: "Shopper not found." });
    const [kycDocuments, finance] = await Promise.all([
      prisma.kycDocument.findMany({ where: { userId: shopper.user.id }, orderBy: { createdAt: "desc" } }),
      financeBreakdownForUser(shopper.user.id),
    ]);
    res.json({ shopper, kycDocuments, finance });
  } catch (err) {
    next(err);
  }
}

async function setVendorVerified(req, res, next) {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") return res.status(400).json({ error: "isVerified (boolean) is required." });
    const vendor = await prisma.vendorProfile.update({ where: { id: req.params.id }, data: { isVerified } });
    await logAdminAction(req.user, "VENDOR_VERIFIED", "VendorProfile", vendor.id, `Set isVerified=${isVerified} for ${vendor.bizName}`);
    res.json({ vendor });
  } catch (err) {
    next(err);
  }
}

async function setRiderVerified(req, res, next) {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") return res.status(400).json({ error: "isVerified (boolean) is required." });
    const rider = await prisma.riderProfile.update({ where: { id: req.params.id }, data: { isVerified } });
    await logAdminAction(req.user, "RIDER_VERIFIED", "RiderProfile", rider.id, `Set isVerified=${isVerified}`);
    res.json({ rider });
  } catch (err) {
    next(err);
  }
}

async function setShopperVerified(req, res, next) {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") return res.status(400).json({ error: "isVerified (boolean) is required." });
    const shopper = await prisma.shopperProfile.update({ where: { id: req.params.id }, data: { isVerified } });
    await logAdminAction(req.user, "SHOPPER_VERIFIED", "ShopperProfile", shopper.id, `Set isVerified=${isVerified}`);
    res.json({ shopper });
  } catch (err) {
    next(err);
  }
}

// KYC review queue — every submitted document, most recent first, so an
// admin can work top-down. Filter by status (defaults to the actual work
// queue: PENDING) via ?status=.
async function listKycDocumentsForAdmin(req, res, next) {
  try {
    const { status } = req.query;
    const documents = await prisma.kycDocument.findMany({
      where: { status: status || "PENDING" },
      include: { user: { select: { name: true, email: true, phone: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ documents });
  } catch (err) {
    next(err);
  }
}

async function reviewKycDocument(req, res, next) {
  try {
    const { status, rejectionReason } = req.body;
    if (!["APPROVED", "REJECTED"].includes(status)) return res.status(400).json({ error: "status must be APPROVED or REJECTED." });
    const document = await prisma.kycDocument.update({
      where: { id: req.params.id },
      data: { status, rejectionReason: status === "REJECTED" ? rejectionReason || null : null, reviewedAt: new Date() },
    });
    await logAdminAction(req.user, "KYC_REVIEWED", "KycDocument", document.id, `${status}${rejectionReason ? " — " + rejectionReason : ""}`);
    res.json({ document });
  } catch (err) {
    next(err);
  }
}

async function listWithdrawalsForAdmin(req, res, next) {
  try {
    const { status } = req.query;
    const withdrawals = await prisma.withdrawal.findMany({
      where: { ...(status && { status }) },
      include: { wallet: { include: { user: { select: { name: true, email: true } } } } },
      orderBy: { requestedAt: "desc" },
      take: 100,
    });
    res.json({ withdrawals });
  } catch (err) {
    next(err);
  }
}

// "Live Shop-For-Me" control center — every session with who's on it and
// where it's at, most recent first. Powers the admin panel's monitoring
// table; getShopSessionTimeline below powers the click-through detail.
async function listShopSessionsForAdmin(req, res, next) {
  try {
    const { status } = req.query;
    const sessions = await prisma.shopSession.findMany({
      where: { ...(status && { status }) },
      include: {
        customer: { select: { name: true } },
        shopper: { include: { user: { select: { name: true } } } },
        rider: { include: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        customerName: s.customer?.name || "—",
        shopperName: s.shopper?.user?.name || "—",
        riderName: s.rider?.user?.name || "—",
        itemsTotalKobo: s.itemsTotalKobo,
        sessionFeeKobo: s.sessionFeeKobo,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function getShopSessionTimeline(req, res, next) {
  try {
    const session = await prisma.shopSession.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { name: true, phone: true } },
        shopper: { include: { user: { select: { name: true, phone: true } } } },
        rider: { include: { user: { select: { name: true, phone: true } } } },
        items: true,
        escrowHolds: true,
        sellerPayouts: { include: { seller: true } },
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found." });

    // A simple ordered checklist derived from the timestamps this model
    // already tracks, rather than a separate event-log table — good
    // enough for "what stage did this reach and when."
    const timeline = [
      { label: "Request created", at: session.createdAt },
      { label: "Shopper matched", at: session.matchedAt },
      { label: "Delivered", at: session.deliveredAt },
      { label: "Completed", at: session.completedAt },
      { label: "Cancelled", at: session.cancelledAt },
    ].filter((t) => t.at);

    res.json({ session, timeline });
  } catch (err) {
    next(err);
  }
}

// Support-desk lookup for the handover codes a rider must be told
// verbally/in-app by the shopper (pickup) or customer (delivery) — see
// ShopSession.pickupCode/.deliveryCode. Only meaningful once a rider is
// assigned, so scoped to those two statuses.
async function lookupActiveCodes(req, res, next) {
  try {
    const sessions = await prisma.shopSession.findMany({
      where: { status: { in: ["RIDER_ASSIGNED", "OUT_FOR_DELIVERY"] } },
      include: {
        customer: { select: { name: true, phone: true } },
        shopper: { include: { user: { select: { name: true, phone: true } } } },
        rider: { include: { user: { select: { name: true, phone: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        customerName: s.customer?.name || "—",
        shopperName: s.shopper?.user?.name || "—",
        riderName: s.rider?.user?.name || "—",
        pickupCode: s.pickupCode,
        deliveryCode: s.deliveryCode,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── Payments: real money movement, read from the wallet ledger rather
// than a separate table — Transaction already captures every deposit,
// escrow hold/release/refund, payout, commission, and feature-boost
// payment across the whole app, so this is a pure view. ──
async function listPayments(req, res, next) {
  try {
    const { type, page = 1, pageSize = 50 } = req.query;
    const take = Math.min(parseInt(pageSize, 10) || 50, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where = { ...(type && { type }) };
    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { wallet: { include: { user: { select: { name: true, email: true, role: true } } } } },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.transaction.count({ where }),
    ]);
    res.json({
      payments: items.map((t) => ({
        id: t.id,
        type: t.type,
        amountKobo: t.amountKobo,
        balanceAfterKobo: t.balanceAfterKobo,
        contextType: t.contextType,
        contextId: t.contextId,
        reference: t.reference,
        description: t.description,
        payerName: t.wallet?.user?.name || "—",
        payerRole: t.wallet?.user?.role || "—",
        createdAt: t.createdAt,
      })),
      total,
      page: Number(page),
      pageSize: take,
    });
  } catch (err) {
    next(err);
  }
}

// ── Bookings: home cook / event planner bookings — previously had zero
// admin visibility at all (only ShopSession did). No rider field here on
// purpose: bookings are customer+vendor only, riders only ever attach to
// ShopSession deliveries in this app's real data model. ──
async function listBookingsForAdmin(req, res, next) {
  try {
    const { status, state } = req.query;
    const bookings = await prisma.booking.findMany({
      where: {
        ...(status && { status }),
        ...(state && { customer: { state } }),
      },
      include: {
        customer: { select: { name: true, phone: true, state: true } },
        vendor: { select: { bizName: true, vtype: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

async function getBookingDetailForAdmin(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { name: true, phone: true, email: true, state: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        servicePackage: true,
        escrowHolds: true,
        ratings: true,
      },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

// ── Commissions: flat per-vendor list — "which vendors owe how much" —
// distinct from Reports' platform-wide PENDING/PAID/OVERDUE aggregate
// cards, which can't answer "which specific vendor." ──
async function listCommissionsForAdmin(req, res, next) {
  try {
    const { status } = req.query;
    const periods = await prisma.commissionPeriod.findMany({
      where: { ...(status && { status }) },
      include: { vendor: { select: { bizName: true, vtype: true, user: { select: { name: true } } } } },
      orderBy: [{ status: "asc" }, { periodEnd: "desc" }],
      take: 200,
    });
    res.json({ periods });
  } catch (err) {
    next(err);
  }
}

// ── Escrow: flat platform-wide list of every hold — mirrors listPayments'
// ledger-table pattern exactly, just against EscrowHold instead of
// Transaction. Nothing like this existed before; escrow was only ever
// visible as an aggregate number (Dashboard) or nested inside one Shop
// Session's own detail view. ──
async function listEscrowHoldsForAdmin(req, res, next) {
  try {
    const { status, contextType, page = 1, pageSize = 50 } = req.query;
    const take = Math.min(parseInt(pageSize, 10) || 50, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where = { ...(status && { status }), ...(contextType && { contextType }) };
    const [items, total] = await Promise.all([
      prisma.escrowHold.findMany({
        where,
        include: {
          booking: { include: { vendor: { select: { bizName: true } } } },
          shopSession: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.escrowHold.count({ where }),
    ]);
    const payerIds = [...new Set(items.map((h) => h.payerId))];
    const payeeIds = [...new Set(items.map((h) => h.payeeId).filter(Boolean))];
    const users = await prisma.user.findMany({ where: { id: { in: [...payerIds, ...payeeIds] } }, select: { id: true, name: true } });
    const nameById = Object.fromEntries(users.map((u) => [u.id, u.name]));
    res.json({
      holds: items.map((h) => ({
        id: h.id,
        contextType: h.contextType,
        label: h.contextType === "BOOKING" && h.booking ? h.booking.vendor.bizName : h.contextType === "SHOP_SESSION" ? "Shop-For-Me Session" : "—",
        payerName: nameById[h.payerId] || "—",
        payeeName: h.payeeRole === "PLATFORM" ? "Platform" : nameById[h.payeeId] || "—",
        payeeRole: h.payeeRole,
        amountKobo: h.amountKobo,
        status: h.status,
        autoReleaseAt: h.autoReleaseAt,
        createdAt: h.createdAt,
      })),
      total,
      page: Number(page),
      pageSize: take,
    });
  } catch (err) {
    next(err);
  }
}

// ── Ratings/Reviews: no admin visibility existed at all before — an
// individual Rating's score/comment could not be viewed anywhere. ──
async function listRatingsForAdmin(req, res, next) {
  try {
    const { rateeRole, contextType } = req.query;
    const ratings = await prisma.rating.findMany({
      where: { ...(rateeRole && { rateeRole }), ...(contextType && { contextType }) },
      include: {
        rater: { select: { name: true } },
        ratee: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ ratings });
  } catch (err) {
    next(err);
  }
}

// ── Riders: dedicated list, mirroring the Vendors admin tab. Verify
// toggle already exists (PATCH /admin/riders/:id/verify), unchanged. ──
async function listRidersForAdmin(req, res, next) {
  try {
    const { online, verified, state } = req.query;
    const riders = await prisma.riderProfile.findMany({
      where: {
        ...(online === "true" && { isOnline: true }),
        ...(verified === "true" && { isVerified: true }),
        ...(verified === "false" && { isVerified: false }),
        ...(state && { user: { state } }),
      },
      include: { user: { select: { name: true, email: true, phone: true, state: true, lga: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ riders });
  } catch (err) {
    next(err);
  }
}

async function listShoppersForAdmin(req, res, next) {
  try {
    const { online, verified, state } = req.query;
    const shoppers = await prisma.shopperProfile.findMany({
      where: {
        ...(online === "true" && { isOnline: true }),
        ...(verified === "true" && { isVerified: true }),
        ...(verified === "false" && { isVerified: false }),
        ...(state && { user: { state } }),
      },
      include: { user: { select: { name: true, email: true, phone: true, state: true, lga: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ shoppers });
  } catch (err) {
    next(err);
  }
}

// ── Subscriptions: Handa's real recurring-payment concept is a vendor's
// paid "featured listing" boost (FeatureBoost), not a school-plan-style
// subscription — surfaced here with a computed ACTIVE/EXPIRED status
// rather than a stored one, since expiry is just "is endAt in the past." ──
async function listSubscriptionsForAdmin(req, res, next) {
  try {
    const { status } = req.query;
    const boosts = await prisma.featureBoost.findMany({
      include: { vendor: { include: { user: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const now = new Date();
    let mapped = boosts.map((b) => ({
      id: b.id,
      vendorId: b.vendorId,
      vendorName: b.vendor?.bizName || b.vendor?.user?.name || "—",
      amountPaidKobo: b.amountPaidKobo,
      startAt: b.startAt,
      endAt: b.endAt,
      status: b.endAt > now ? "ACTIVE" : "EXPIRED",
      createdAt: b.createdAt,
    }));
    if (status) mapped = mapped.filter((b) => b.status === status);
    res.json({ subscriptions: mapped });
  } catch (err) {
    next(err);
  }
}

async function extendSubscription(req, res, next) {
  try {
    const { endAt } = req.body;
    if (!endAt) return res.status(400).json({ error: "endAt is required." });
    const newEndAt = new Date(endAt);
    if (Number.isNaN(newEndAt.getTime())) return res.status(400).json({ error: "endAt must be a valid date." });

    const boost = await prisma.featureBoost.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!boost) return res.status(404).json({ error: "Subscription not found." });

    const updated = await prisma.featureBoost.update({ where: { id: boost.id }, data: { endAt: newEndAt } });
    // FeatureBoost.endAt and VendorProfile.featuredUntil are meant to stay
    // in lockstep (the catalog reads featuredUntil to decide who's
    // featured) — only bump it forward if this is still the vendor's
    // latest boost, so an older boost's manual edit can't un-feature a
    // vendor with a newer one already active.
    if (!boost.vendor.featuredUntil || boost.vendor.featuredUntil <= boost.endAt) {
      await prisma.vendorProfile.update({ where: { id: boost.vendorId }, data: { featuredUntil: newEndAt } });
    }
    await logAdminAction(req.user, "SUBSCRIPTION_EXTENDED", "FeatureBoost", boost.id, `Extended to ${newEndAt.toISOString()}`);
    res.json({ subscription: updated });
  } catch (err) {
    next(err);
  }
}

// ── App Settings: generic JSON-encoded key/value config store. Nothing
// in the running app reads from it yet — same as PassNow's own version —
// it exists so config can be recorded/adjusted without a code change. ──
async function listAppSettings(req, res, next) {
  try {
    const settings = await prisma.appSetting.findMany({
      include: { updatedBy: { select: { name: true } } },
      orderBy: { key: "asc" },
    });
    res.json({ settings: settings.map((s) => ({ ...s, value: JSON.parse(s.value), updatedByName: s.updatedBy?.name || null })) });
  } catch (err) {
    next(err);
  }
}

async function upsertAppSetting(req, res, next) {
  try {
    const { key } = req.params;
    const { value, category, description } = req.body;
    if (value === undefined) return res.status(400).json({ error: "value is required." });
    const encodedValue = JSON.stringify(value);
    const setting = await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: encodedValue, category: category || null, description: description || null, updatedById: req.user.id },
      update: { value: encodedValue, ...(category !== undefined && { category }), ...(description !== undefined && { description }), updatedById: req.user.id },
    });
    await logAdminAction(req.user, "APP_SETTING_UPDATE", "AppSetting", key, `Set to ${encodedValue.slice(0, 200)}`);
    res.json({ setting: { ...setting, value: JSON.parse(setting.value) } });
  } catch (err) {
    next(err);
  }
}

async function deleteAppSetting(req, res, next) {
  try {
    const { key } = req.params;
    const existing = await prisma.appSetting.findUnique({ where: { key } });
    if (!existing) return res.status(404).json({ error: "Setting not found." });
    await prisma.appSetting.delete({ where: { key } });
    await logAdminAction(req.user, "APP_SETTING_DELETE", "AppSetting", key, null);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── Announcements: fan out a Notification (type ANNOUNCEMENT) to every
// ACTIVE user in the targeted roles, and keep one summary row here as
// the admin-facing "what did we send and to how many people" history. ──
const ANNOUNCEMENT_ROLES = ["CUSTOMER", "VENDOR", "RIDER", "SHOPPER"];

async function listAnnouncements(req, res, next) {
  try {
    const announcements = await prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ announcements });
  } catch (err) {
    next(err);
  }
}

async function sendAnnouncement(req, res, next) {
  try {
    const { title, body, roles } = req.body;
    if (!title || !body) return res.status(400).json({ error: "title and body are required." });
    const targetRoles = Array.isArray(roles) && roles.length ? roles.filter((r) => ANNOUNCEMENT_ROLES.includes(r)) : ANNOUNCEMENT_ROLES;
    if (!targetRoles.length) return res.status(400).json({ error: "No valid target roles given." });

    const recipients = await prisma.user.findMany({ where: { role: { in: targetRoles }, status: "ACTIVE" }, select: { id: true } });
    if (recipients.length) {
      await prisma.notification.createMany({
        data: recipients.map((r) => ({ userId: r.id, type: "ANNOUNCEMENT", title: title.trim(), body: body.trim() })),
      });
    }
    const announcement = await prisma.announcement.create({
      data: { title: title.trim(), body: body.trim(), targetRoles, sentById: req.user.id, sentByName: req.user.name, recipientCount: recipients.length },
    });

    req.app.get("io") &&
      recipients.forEach((r) => req.app.get("io").to(`user:${r.id}`).emit("notification:new", { title: announcement.title, body: announcement.body }));

    await logAdminAction(req.user, "ANNOUNCEMENT_SENT", "Announcement", announcement.id, `"${title}" to ${recipients.length} user(s) (${targetRoles.join(", ")})`);
    res.status(201).json({ announcement });
  } catch (err) {
    next(err);
  }
}

// ── AI Conversations: viewer for the AI Meal Planner's question/answer
// log. Empty today — the meal planner is still the frontend's hardcoded
// demo, nothing writes to AiConversationLog yet. Ready the moment a real
// AI provider is wired up; no further schema change needed then. ──
async function listAiConversations(req, res, next) {
  try {
    const { page = 1, pageSize = 50, userId } = req.query;
    const take = Math.min(parseInt(pageSize, 10) || 50, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where = { ...(userId && { userId }) };
    const [items, total] = await Promise.all([
      prisma.aiConversationLog.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.aiConversationLog.count({ where }),
    ]);
    res.json({ conversations: items, total, page: Number(page), pageSize: take });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  dashboardStats,
  getReports,
  listUsers,
  updateUserStatus,
  listVendorsForAdmin,
  getVendorDetailForAdmin,
  deleteMenuItemForAdmin,
  deleteServicePackageForAdmin,
  getRiderDetailForAdmin,
  getShopperDetailForAdmin,
  setVendorVerified,
  setRiderVerified,
  setShopperVerified,
  listPayments,
  listRidersForAdmin,
  listShoppersForAdmin,
  listBookingsForAdmin,
  getBookingDetailForAdmin,
  listCommissionsForAdmin,
  listEscrowHoldsForAdmin,
  listRatingsForAdmin,
  listSubscriptionsForAdmin,
  extendSubscription,
  listAppSettings,
  upsertAppSetting,
  deleteAppSetting,
  listAnnouncements,
  sendAnnouncement,
  listAiConversations,
  listKycDocumentsForAdmin,
  reviewKycDocument,
  listWithdrawalsForAdmin,
  listShopSessionsForAdmin,
  getShopSessionTimeline,
  lookupActiveCodes,
};
