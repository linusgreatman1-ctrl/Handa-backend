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
          vendorProfile: { select: { vtype: true, bizName: true, isVerified: true, isOnline: true } },
          riderProfile: { select: { isOnline: true, ratingAvg: true, deliveries: true } },
          shopperProfile: { select: { isOnline: true, ratingAvg: true } },
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

module.exports = { dashboardStats, listUsers, updateUserStatus, listVendorsForAdmin, setVendorVerified, listWithdrawalsForAdmin };
