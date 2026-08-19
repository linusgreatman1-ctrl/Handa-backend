const prisma = require("../config/db");
const { hashPassword, isStrongPassword } = require("../utils/password");
const { logAdminAction } = require("../services/auditLog.service");

// Everything here is mounted behind requireSuperAdmin — see admin.routes.js.
// Ordinary admins never reach these endpoints at all.

async function listAdmins(req, res, next) {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, name: true, email: true, phone: true, isSuperAdmin: true, status: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ admins });
  } catch (err) {
    next(err);
  }
}

async function createAdmin(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email, and password are required." });
    if (!isStrongPassword(password)) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });

    const passwordHash = await hashPassword(password);
    // Never super — promoting an admin to super-admin isn't exposed
    // through the API, only via the one-time migration backfill.
    const admin = await prisma.user.create({
      data: { name, email, passwordHash, role: "ADMIN", isSuperAdmin: false, wallet: { create: {} }, notificationPref: { create: {} } },
      select: { id: true, name: true, email: true, phone: true, isSuperAdmin: true, status: true, createdAt: true },
    });

    await logAdminAction(req.user, "ADMIN_CREATED", "User", admin.id, `Created admin ${admin.name} (${admin.email})`);
    res.status(201).json({ admin });
  } catch (err) {
    next(err);
  }
}

async function findTargetAdmin(id) {
  return prisma.user.findUnique({ where: { id } });
}

async function suspendAdmin(req, res, next) {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot suspend your own account." });
    const target = await findTargetAdmin(req.params.id);
    if (!target || target.role !== "ADMIN") return res.status(404).json({ error: "Admin not found." });

    const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "SUSPENDED" } });
    await logAdminAction(req.user, "ADMIN_SUSPENDED", "User", target.id, `Suspended admin ${target.name} (${target.email})`);
    res.json({ admin: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
}

async function reactivateAdmin(req, res, next) {
  try {
    const target = await findTargetAdmin(req.params.id);
    if (!target || target.role !== "ADMIN") return res.status(404).json({ error: "Admin not found." });

    const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "ACTIVE" } });
    await logAdminAction(req.user, "ADMIN_REACTIVATED", "User", target.id, `Reactivated admin ${target.name} (${target.email})`);
    res.json({ admin: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
}

async function removeAdmin(req, res, next) {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot remove your own account." });
    const target = await findTargetAdmin(req.params.id);
    if (!target || target.role !== "ADMIN") return res.status(404).json({ error: "Admin not found." });

    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { status: "DELETED" } }),
      prisma.refreshToken.updateMany({ where: { userId: target.id, revoked: false }, data: { revoked: true } }),
    ]);
    await logAdminAction(req.user, "ADMIN_REMOVED", "User", target.id, `Removed admin ${target.name} (${target.email})`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function listAuditLog(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 50);
    const [logs, total] = await Promise.all([
      prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.adminAuditLog.count(),
    ]);
    res.json({ logs, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAdmins, createAdmin, suspendAdmin, reactivateAdmin, removeAdmin, listAuditLog };
