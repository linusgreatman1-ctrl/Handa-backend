const prisma = require("../config/db");

// Fire-and-forget: a logging failure must never break the real admin
// action it's recording. actorName/actorEmail are snapshotted rather than
// joined at read time, so a log entry stays readable even after the
// acting admin is later removed.
async function logAdminAction(actor, action, targetType, targetId, details) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorName: actor.name,
        actorEmail: actor.email || null,
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        details: details || null,
      },
    });
  } catch (err) {
    console.error("[auditLog] failed to record action:", action, err.message);
  }
}

module.exports = { logAdminAction };
