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

module.exports = { notify };
