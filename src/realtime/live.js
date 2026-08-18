const { Server } = require("socket.io");
const prisma = require("../config/db");
const { verifyAccessToken } = require("../utils/jwt");
const escrowSvc = require("../services/escrow.service");

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
//   vendor:{vendorProfileId} — a vendor's own dashboard (new order/booking alerts)
//   order:{orderId}        — customer + assigned vendor/rider watching one order
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
    // socket can't eavesdrop on someone else's order/session/chat by
    // guessing an id. ──

    socket.on("order:join", async ({ orderId }) => {
      if (!orderId) return;
      const order = await prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
      if (!order) return;
      const allowed =
        order.customerId === user.id ||
        (user.vendorProfile && order.vendorId === user.vendorProfile.id) ||
        (user.riderProfile && order.riderId === user.riderProfile.id);
      if (allowed) socket.join(`order:${orderId}`);
    });

    socket.on("booking:join", async ({ bookingId }) => {
      if (!bookingId) return;
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return;
      const allowed = booking.customerId === user.id || (user.vendorProfile && booking.vendorId === user.vendorProfile.id);
      if (allowed) socket.join(`booking:${bookingId}`);
    });

    socket.on("shop-session:join", async ({ sessionId }) => {
      if (!sessionId) return;
      const session = await prisma.shopSession.findUnique({ where: { id: sessionId } });
      if (!session) return;
      const allowed =
        session.customerId === user.id ||
        (user.shopperProfile && session.shopperId === user.shopperProfile.id) ||
        (user.riderProfile && session.riderId === user.riderProfile.id);
      if (allowed) socket.join(`shop-session:${sessionId}`);
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
      const [activeOrders, activeSessions] = await Promise.all([
        prisma.order.findMany({ where: { riderId: user.riderProfile.id, status: { in: ["RIDER_ASSIGNED", "PICKED_UP"] } }, select: { id: true } }),
        prisma.shopSession.findMany({ where: { riderId: user.riderProfile.id, status: { in: ["RIDER_ASSIGNED", "OUT_FOR_DELIVERY"] } }, select: { id: true } }),
      ]);
      const payload = { riderId: user.riderProfile.id, lat, lng, at: new Date().toISOString() };
      activeOrders.forEach((o) => io.to(`order:${o.id}`).emit("rider:location", payload));
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

  return io;
}

module.exports = { attachLiveSocket };
