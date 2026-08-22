const { Server } = require("socket.io");
const prisma = require("../config/db");
const { verifyAccessToken } = require("../utils/jwt");
const escrowSvc = require("../services/escrow.service");
const commissionSvc = require("../services/commission.service");
const shopSessionsCtrl = require("../controllers/shopSessions.controller");
const bookingRemindersSvc = require("../services/bookingReminders.service");

// Replaces every client-side setTimeout/setInterval "simulation" in the
// frontend prototype (rider map animation, live-call approval sync,
// auto-advancing delivery timeline, escrow auto-release countdown) with
// real server-pushed events. Room state (who's connected) lives in this
// process's memory — fine for a single instance, would need the
// socket.io Redis adapter to scale horizontally.
//
// Room map:
//   user:{userId}          — personal channel (notifications)
//   dispatch:riders        — every ONLINE rider, for new-delivery broadcasts
//   dispatch:shoppers      — every ONLINE shopper, for new-session broadcasts
//   vendor:{vendorProfileId} — a vendor's own dashboard (new booking alerts)
//   booking:{bookingId}
//   shop-session:{sessionId}
//   chat:{threadId}
function attachLiveSocket(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Authentication required."));
      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch (err) {
        return next(new Error("Invalid or expired token."));
      }
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          status: true,
          name: true,
          vendorProfile: { select: { id: true } },
          riderProfile: { select: { id: true } },
          shopperProfile: { select: { id: true } },
        },
      });
      if (!user || user.status !== "ACTIVE") return next(new Error("Account is not active."));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Authentication failed."));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    if (user.vendorProfile) socket.join(`vendor:${user.vendorProfile.id}`);
    if (user.riderProfile) socket.join(`dispatch:riders`);
    if (user.shopperProfile) socket.join(`dispatch:shoppers`);

    // ── Explicit room joins, each gated by an actual access check so a
    // socket can't eavesdrop on someone else's booking/session/chat by
    // guessing an id. ──

    socket.on("booking:join", async ({ bookingId }) => {
      if (!bookingId) return;
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return;
      const allowed = booking.customerId === user.id || (user.vendorProfile && booking.vendorId === user.vendorProfile.id);
      if (allowed) socket.join(`booking:${bookingId}`);
    });

    // Accepts an optional ack callback — callers that need to act
    // immediately after joining (e.g. starting the WebRTC signaling below,
    // which needs the room join to have actually landed) can await it
    // instead of racing the async DB lookup this handler does internally.
    socket.on("shop-session:join", async ({ sessionId }, ack) => {
      if (!sessionId) return typeof ack === "function" && ack({ joined: false });
      const session = await prisma.shopSession.findUnique({ where: { id: sessionId } });
      if (!session) return typeof ack === "function" && ack({ joined: false });
      const allowed =
        session.customerId === user.id ||
        (user.shopperProfile && session.shopperId === user.shopperProfile.id) ||
        (user.riderProfile && session.riderId === user.riderProfile.id);
      if (allowed) socket.join(`shop-session:${sessionId}`);
      if (typeof ack === "function") ack({ joined: !!allowed });
    });

    socket.on("chat:join", async ({ threadId }) => {
      if (!threadId) return;
      const participant = await prisma.chatParticipant.findUnique({ where: { threadId_userId: { threadId, userId: user.id } } });
      if (participant) socket.join(`chat:${threadId}`);
    });

    // Typing indicator for whichever chat/live-call thread is open — pure
    // relay, no persistence.
    socket.on("chat:typing", ({ threadId }) => {
      if (threadId) socket.to(`chat:${threadId}`).emit("chat:typing", { threadId, userId: user.id });
    });

    // ── Rider live location — the frontend's map/tracking screens read
    // this instead of animating a canned SVG path. ──
    socket.on("rider:location", async ({ lat, lng }) => {
      if (!user.riderProfile || typeof lat !== "number" || typeof lng !== "number") return;
      await prisma.riderProfile.update({
        where: { id: user.riderProfile.id },
        data: { currentLat: lat, currentLng: lng, locationUpdatedAt: new Date() },
      });
      const activeSessions = await prisma.shopSession.findMany({
        where: { riderId: user.riderProfile.id, status: { in: ["RIDER_ASSIGNED", "OUT_FOR_DELIVERY"] } },
        select: { id: true },
      });
      const payload = { riderId: user.riderProfile.id, lat, lng, at: new Date().toISOString() };
      activeSessions.forEach((s) => io.to(`shop-session:${s.id}`).emit("rider:location", payload));
    });

    // ── WebRTC signaling relay for the Shop-For-Me live video call —
    // this server only exchanges the small SDP/ICE handshake messages;
    // actual video/audio goes directly between the customer's and
    // shopper's browsers. ──
    ["webrtc:offer", "webrtc:answer", "webrtc:ice-candidate"].forEach((evt) => {
      socket.on(evt, (payload) => {
        if (!payload || !payload.toSocketId) return;
        io.to(payload.toSocketId).emit(evt, Object.assign({}, payload, { fromSocketId: socket.id }));
      });
    });

    // Peer discovery for the call: whoever joins the shop-session room for
    // the call learns who's already there (in case the other side joined
    // first), and everyone already in the room learns about the new
    // arrival — either order works, since offer/answer roles are fixed
    // client-side (shopper always offers) rather than decided by join order.
    socket.on("webrtc:join-call", ({ sessionId }) => {
      if (!sessionId) return;
      const room = `shop-session:${sessionId}`;
      if (!socket.rooms.has(room)) return;
      const members = io.sockets.adapter.rooms.get(room);
      const existing = members ? [...members].filter((id) => id !== socket.id) : [];
      socket.emit("webrtc:existing-peers", { sessionId, socketIds: existing });
      socket.to(room).emit("webrtc:peer-joined", { sessionId, fromSocketId: socket.id });
    });

    socket.on("webrtc:leave-call", ({ sessionId }) => {
      if (!sessionId) return;
      socket.to(`shop-session:${sessionId}`).emit("webrtc:peer-left", { sessionId, fromSocketId: socket.id });
    });

    // "disconnecting" (not "disconnect") fires while socket.rooms is still
    // populated, so a dropped tab/network still tells the other side of
    // any live call to tear down instead of hanging on a dead peer.
    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("shop-session:")) {
          const sessionId = room.slice("shop-session:".length);
          socket.to(room).emit("webrtc:peer-left", { sessionId, fromSocketId: socket.id });
        }
      }
    });

    socket.on("disconnect", () => {});
  });

  // Server-side escrow auto-release — replaces the frontend's
  // window._escrowTimer/_codTimer client setTimeouts, which stopped
  // running the moment a tab closed and would otherwise strand a
  // vendor/rider/shopper's payout forever.
  const sweepMs = 5 * 60 * 1000;
  setInterval(() => {
    escrowSvc.runAutoReleaseSweep().catch((err) => console.error("[escrow] auto-release sweep failed:", err));
  }, sweepMs);

  // Same off-request-path pattern as the escrow sweep above — a vendor's
  // commission period lapsing into OVERDUE isn't something any single
  // request naturally triggers, so it needs its own periodic check.
  setInterval(() => {
    commissionSvc.markOverduePeriods().catch((err) => console.error("[commission] overdue sweep failed:", err));
  }, sweepMs);

  // A Shop-For-Me session no shopper ever accepts shouldn't sit in
  // SEARCHING forever — refund and cancel it after 30 minutes so the
  // customer knows to search again, same off-request-path pattern.
  setInterval(() => {
    shopSessionsCtrl.expireStaleSearchingSessions(io).catch((err) => console.error("[shop-session] expiry sweep failed:", err));
  }, sweepMs);

  // Reminds a vendor (home cook / event planner) ~24h and ~2h before an
  // accepted/confirmed booking's event time — same off-request-path
  // pattern as the sweeps above.
  setInterval(() => {
    bookingRemindersSvc.sendUpcomingReminders(io).catch((err) => console.error("[booking] reminder sweep failed:", err));
  }, sweepMs);

  // Once a booking's own scheduled time is 2h in the past and it still
  // isn't COMPLETED, keep nudging whichever side hasn't acted yet — every
  // tick, not just once, until the two-sided completion flow finishes.
  setInterval(() => {
    bookingRemindersSvc.sendCompletionReminders(io).catch((err) => console.error("[booking] completion reminder sweep failed:", err));
  }, sweepMs);

  return io;
}

module.exports = { attachLiveSocket };
