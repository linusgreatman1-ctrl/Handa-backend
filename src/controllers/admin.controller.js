const prisma = require("../config/db");

// Headline numbers for the admin panel's landing dashboard — cheap
// aggregate counts, not full row dumps.
async function dashboardStats(req, res, next) {
  try {
    const [usersByRole, ordersByStatus, bookingsByStatus, sessionsByStatus, openTickets, pendingWithdrawals, heldEscrow, gmv] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: true }),
      prisma.order.groupBy({ by: ["status"], _count: true }),
      prisma.booking.groupBy({ by: ["status"], _count: true }),
      prisma.shopSession.groupBy({ by: ["status"], _count: true }),
      prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      prisma.withdrawal.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.escrowHold.aggregate({ where: { status: "HELD" }, _sum: { amountKobo: true } }),
      prisma.order.aggregate({ where: { status: { in: ["DELIVERED", "CONFIRMED"] } }, _sum: { totalKobo: true } }),
    ]);

    res.json({
      usersByRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count])),
      ordersByStatus: Object.fromEntries(ordersByStatus.map((r) => [r.status, r._count])),
      bookingsByStatus: Object.fromEntries(bookingsByStatus.map((r) => [r.status, r._count])),
      shopSessionsByStatus: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r._count])),
      openTickets,
      pendingWithdrawals,
      heldEscrowKobo: heldEscrow._sum.amountKobo || 0,
      grossMerchandiseValueKobo: gmv._sum.totalKobo || 0,
    });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const { role, status, q } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 25);

    const where = {
      ...(role && { role }),
      ...(status && { status }),
      ...(q && { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, role: true, status: true, createdAt: true, lastLoginAt: true,
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

    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
    res.json({ user: { id: user.id, status: user.status } });
  } catch (err) {
    next(err);
  }
}

async function listVendorsForAdmin(req, res, next) {
  try {
    const { vtype, verified } = req.query;
    const vendors = await prisma.vendorProfile.findMany({
      where: {
        ...(vtype && { vtype }),
        ...(verified !== undefined && { isVerified: verified === "true" }),
      },
      include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ vendors });
  } catch (err) {
    next(err);
  }
}

async function setVendorVerified(req, res, next) {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") return res.status(400).json({ error: "isVerified (boolean) is required." });
    const vendor = await prisma.vendorProfile.update({ where: { id: req.params.id }, data: { isVerified } });
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

module.exports = {
  dashboardStats,
  listUsers,
  updateUserStatus,
  listVendorsForAdmin,
  setVendorVerified,
  setRiderVerified,
  setShopperVerified,
  listKycDocumentsForAdmin,
  reviewKycDocument,
  listWithdrawalsForAdmin,
  listShopSessionsForAdmin,
  getShopSessionTimeline,
};
