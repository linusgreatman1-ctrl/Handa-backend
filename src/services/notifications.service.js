const prisma = require("../config/db");

const PREF_FIELD_BY_TYPE = {
  ORDER_UPDATE: "orderUpdates",
  PROMOTION: "promotions",
  RIDER_ALERT: "riderAlerts",
  NEW_FEATURE: "newFeatures",
  // CHAT and SYSTEM notifications aren't covered by the frontend's
  // 4-toggle preferences screen — always delivered.
};

// Respects the same 4 toggles the frontend's notification-preferences
// screen shows (Order updates / Promotions / Rider alerts / New features)
// — a muted category still gets written to the DB (so it shows up if the
// user later re-enables it) but isn't pushed over the socket.
async function notify(io, userId, type, title, body, data) {
  const notification = await prisma.notification.create({ data: { userId, type, title, body, data } });

  const prefField = PREF_FIELD_BY_TYPE[type];
  if (prefField) {
    const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (pref && pref[prefField] === false) return notification;
  }

  io?.to(`user:${userId}`).emit("notification:new", notification);
  return notification;
}

// Fans a SYSTEM notification out to every active admin -- same real
// Notification rows + socket push as notify() above (SYSTEM has no pref
// toggle, so it's never muted), just resolving "every admin" once instead
// of every call site re-writing that same findMany + loop. Mirrors the
// pattern already proven for SOS alerts (shopSessions.controller.js).
async function notifyAllAdmins(io, title, body, data) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  for (const admin of admins) {
    await notify(io, admin.id, "SYSTEM", title, body, data).catch(() => {});
  }
}

// Same fan-out pattern as notifyAllAdmins, for every active Event Planner
// vendor -- a new event request previously only ever surfaced live via
// the dispatch:eventplanners socket room (event-request:updated), which
// only actually does anything for a planner who already happens to have
// their dashboard's request section open at that exact moment. Nothing
// wrote a real Notification row, so the bell/notification list never
// showed it at all, live or otherwise.
async function notifyAllEventPlanners(io, title, body, data) {
  const vendors = await prisma.vendorProfile.findMany({
    where: { vtype: "EVENT_PLANNER", user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  for (const v of vendors) {
    await notify(io, v.userId, "ORDER_UPDATE", title, body, data).catch(() => {});
  }
}

module.exports = { notify, notifyAllAdmins, notifyAllEventPlanners };
