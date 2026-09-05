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
//   dispatch:eventplanners — every connected EVENT_PLANNER vendor, for real-time event-request/proposal updates
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
          isSuperAdmin: true,
          isContentAdmin: true,
          vendorProfile: { select: { id: true, vtype: true } },
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
    if (user.vendorProfile && user.vendorProfile.vtype === "EVENT_PLANNER") socket.join(`dispatch:eventplanners`);
    if (user.riderProfile) socket.join(`dispatch:riders`);
    if (user.shopperProfile) socket.join(`dispatch:shoppers`);
    // Real-time Live Chat notifications (see chat.controller.js's
    // maybeSendAiReply) — any admin who can see the Live Chat tab
    // (same isSuperAdmin/isContentAdmin gate the frontend nav uses) gets
    // a push the moment the AI replies to a user, not just when the
    // user's own message lands.
    if (user.role === "ADMIN" && (user.isSuperAdmin || user.isContentAdmin)) socket.join("admins");

    // ── Explicit room joins, each gated by an actual access check so a
    // socket can't eavesdrop on someone else's booking/session/chat by
    // guessing an id. ──

    socket.on("booking:join", async ({ bookingId }, ack) => {
      if (!bookingId) return typeof ack === "function" && ack({ joined: false });
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return typeof ack === "function" && ack({ joined: false });
      const allowed = booking.customerId === user.id || (user.vendorProfile && booking.vendorId === user.vendorProfile.id);
      if (allowed) socket.join(`booking:${bookingId}`);
      if (typeof ack === "function") ack({ joined: !!allowed });
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

    // ── Parallel signaling relay for the post-delivery 3-way (rider +
    // shopper + customer) confirm call — kept on its own event namespace
    // rather than reusing webrtc:* so it can never collide with the
    // 2-party shopping-call state a session may have just torn down.
    // Same relay-only shape: this server only exchanges SDP/ICE, actual
    // audio goes directly peer-to-peer. ──
    ["confirmcall:offer", "confirmcall:answer", "confirmcall:ice-candidate"].forEach((evt) => {
      socket.on(evt, (payload) => {
        if (!payload || !payload.toSocketId) return;
        io.to(payload.toSocketId).emit(evt, Object.assign({}, payload, { fromSocketId: socket.id }));
      });
    });
    socket.on("confirmcall:join", ({ sessionId }) => {
      if (!sessionId) return;
      const room = `shop-session:${sessionId}`;
      if (!socket.rooms.has(room)) return;
      const members = io.sockets.adapter.rooms.get(room);
      const existing = members ? [...members].filter((id) => id !== socket.id) : [];
      socket.emit("confirmcall:existing-peers", { sessionId, socketIds: existing });
      socket.to(room).emit("confirmcall:peer-joined", { sessionId, fromSocketId: socket.id });
    });
    socket.on("confirmcall:leave", ({ sessionId }) => {
      if (!sessionId) return;
      socket.to(`shop-session:${sessionId}`).emit("confirmcall:peer-left", { sessionId, fromSocketId: socket.id });
    });

    // ── Ad-hoc 1:1 call between a customer and vendor (Home Cook / Event
    // Planner) — e.g. from a booking detail screen's real "Call" button,
    // or an inquiry call before a booking even exists. Unlike the
    // Shop-For-Me call, there's no pre-existing shared room both sides
    // are already sitting on, so this needs a real ring handshake: the
    // caller rings the callee's personal user:{userId} room (always
    // joined on connect), and only once the callee accepts do both sides
    // learn each other's live socket id and start real SDP/ICE signaling.
    // Kept on its own bookingcall:* namespace so it can never collide
    // with an SFM/confirm call this same user might also have in flight.
    socket.on("bookingcall:invite", async ({ toUserId, bookingId, callerName, callerAvatar, callerRole }) => {
      if (!toUserId) return;
      if (bookingId) {
        // The frontend reuses this same generic call system for two real
        // contexts: Cook/EP bookings AND Shop-For-Me sessions (customer <->
        // shopper <-> rider), passing whichever id it has as "bookingId" —
        // it's just an opaque scoping token to this handler, not literally
        // always a Booking row. Only checking the Booking table meant every
        // Shop-For-Me in-app call invite silently vanished here (booking
        // lookup returns null, early return), even though the caller had
        // already been through this exact session's own party checks to
        // even see the Call button.
        const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { vendor: { select: { userId: true } } } });
        if (booking) {
          const allowed = booking.customerId === user.id || (booking.vendor && booking.vendor.userId === user.id);
          if (!allowed) return;
        } else {
          const session = await prisma.shopSession.findUnique({
            where: { id: bookingId },
            include: { shopper: { select: { userId: true } }, rider: { select: { userId: true } } },
          });
          if (!session) return;
          const allowed = session.customerId === user.id || (session.shopper && session.shopper.userId === user.id) || (session.rider && session.rider.userId === user.id);
          if (!allowed) return;
        }
      }
      io.to(`user:${toUserId}`).emit("bookingcall:incoming", {
        fromUserId: user.id,
        fromSocketId: socket.id,
        bookingId: bookingId || null,
        callerName: callerName || user.name,
        callerAvatar: callerAvatar || "👤",
        callerRole: callerRole || "",
      });
    });
    socket.on("bookingcall:accept", ({ toSocketId, bookingId }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("bookingcall:accepted", { fromUserId: user.id, fromSocketId: socket.id, bookingId: bookingId || null });
    });
    socket.on("bookingcall:decline", ({ toSocketId, bookingId, reason }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("bookingcall:declined", { fromUserId: user.id, bookingId: bookingId || null, reason: reason || null });
    });
    socket.on("bookingcall:cancel", ({ toUserId, bookingId }) => {
      if (!toUserId) return;
      io.to(`user:${toUserId}`).emit("bookingcall:cancelled", { fromUserId: user.id, bookingId: bookingId || null });
    });
    socket.on("bookingcall:end", ({ toSocketId, bookingId }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("bookingcall:ended", { fromUserId: user.id, bookingId: bookingId || null });
    });
    ["bookingcall:offer", "bookingcall:answer", "bookingcall:ice-candidate"].forEach((evt) => {
      socket.on(evt, (payload) => {
        if (!payload || !payload.toSocketId) return;
        io.to(payload.toSocketId).emit(evt, Object.assign({}, payload, { fromSocketId: socket.id }));
      });
    });

    // Real in-app voice call to Handa Support -- there's no single fixed
    // admin userId to ring the way bookingcall:* rings one specific
    // person, so this broadcasts to every online admin (the "admins" room
    // already joined above) instead. Whichever admin accepts first claims
    // it; every other admin's ringing UI is told to stand down via
    // supportcall:claimed. Once claimed, both sides just have each
    // other's live socketId -- the actual SDP/ICE exchange reuses the
    // bookingcall:offer/answer/ice-candidate/end relay above verbatim,
    // same shape as any other 1:1 call, no separate signaling needed.
    socket.on("supportcall:invite", ({ callerName, callerAvatar } = {}) => {
      socket.join(`supportcall:${socket.id}`);
      io.to("admins").emit("supportcall:incoming", {
        fromUserId: user.id,
        fromSocketId: socket.id,
        callerName: callerName || user.name,
        callerAvatar: callerAvatar || "👤",
      });
    });
    socket.on("supportcall:accept", ({ toSocketId } = {}) => {
      if (!toSocketId) return;
      socket.join(`supportcall:${toSocketId}`);
      io.to(toSocketId).emit("supportcall:accepted", { fromUserId: user.id, fromSocketId: socket.id, adminName: user.name });
      // Tells every OTHER admin this specific pending call is already
      // answered, so their incoming-call UI clears instead of a second
      // admin trying to accept a call someone else already picked up.
      io.to("admins").emit("supportcall:claimed", { fromSocketId: toSocketId, byAdminSocketId: socket.id });
    });
    socket.on("supportcall:cancel", () => {
      io.to("admins").emit("supportcall:cancelled", { fromSocketId: socket.id });
    });

    // "disconnecting" (not "disconnect") fires while socket.rooms is still
    // populated, so a dropped tab/network still tells the other side of
    // any live call to tear down instead of hanging on a dead peer.
    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("shop-session:")) {
          const sessionId = room.slice("shop-session:".length);
          socket.to(room).emit("webrtc:peer-left", { sessionId, fromSocketId: socket.id });
          socket.to(room).emit("confirmcall:peer-left", { sessionId, fromSocketId: socket.id });
        } else if (room.startsWith("booking:")) {
          const bookingId = room.slice("booking:".length);
          socket.to(room).emit("bookingcall:ended", { bookingId, fromUserId: user.id });
        } else if (room.startsWith("supportcall:")) {
          // Either the caller's tab closing mid-ring/mid-call, or the
          // answering admin's tab closing -- either way the other side
          // (whoever's still in this room) needs to know it's over
          // instead of hanging on a peer that will never come back.
          socket.to(room).emit("bookingcall:ended", { bookingId: null, fromUserId: user.id });
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

  // A Shop-For-Me session's holds auto-releasing (above) doesn't tell the
  // session itself anything -- without this, one that auto-releases
  // instead of the customer manually confirming never gets its unspent-
  // budget refund, its payout notifications, or its status flipped to
  // COMPLETED, and just sits at DELIVERED forever even though the money
  // has actually already moved.
  setInterval(() => {
    shopSessionsCtrl.finalizeAutoReleasedSessions(io).catch((err) => console.error("[shop-session] auto-release finalize sweep failed:", err));
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

  // A session a shopper HAS accepted can still get stuck (video call never
  // completes, a connection drops) with nothing else revisiting it — same
  // off-request-path pattern, 2h timeout.
  setInterval(() => {
    shopSessionsCtrl.expireStaleLiveSessions(io).catch((err) => console.error("[shop-session] stale-live-session sweep failed:", err));
  }, sweepMs);

  // A session where one of two pre-items-bought parties (customer/shopper)
  // returned home and the other never followed -- gives the away party a
  // real 10-minute grace window (checked here, not in the request itself)
  // before auto-cancelling. See markAway/expireAbandonedPreItemsSessions.
  setInterval(() => {
    shopSessionsCtrl.expireAbandonedPreItemsSessions(io).catch((err) => console.error("[shop-session] abandoned-pre-items sweep failed:", err));
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

  // Event Planner has no two-sided confirmation step at all -- if the
  // vendor never taps Mark Job Complete, nothing above ever closes the
  // booking out. 24h past the scheduled event, auto-completes it (same
  // escrow release + 10% commission as a real vendor-triggered complete).
  setInterval(() => {
    bookingRemindersSvc.autoCompleteOverdueEventPlannerBookings(io).catch((err) => console.error("[booking] EP auto-complete sweep failed:", err));
  }, sweepMs);

  // Real-time push to the EP the calendar day their event arrives (the
  // row write-up itself is computed live client-side -- this is just the
  // explicit notification, which nothing else originates).
  setInterval(() => {
    bookingRemindersSvc.sendEventDayReminders(io).catch((err) => console.error("[booking] event-day reminder sweep failed:", err));
  }, sweepMs);

  return io;
}

module.exports = { attachLiveSocket };
