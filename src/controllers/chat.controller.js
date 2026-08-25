const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");
const aiChatSvc = require("../services/aiChat.service");

// SUPPORT threads have no real second User (there's no support-inbox
// account in the schema) -- messages need a real senderId to satisfy the
// ChatMessage.sender FK, so the AI's replies come from one lazily-created,
// passwordless system account (same isGuest:true pattern used for guest
// customer accounts).
async function ensureAiSupportUser() {
  let u = await prisma.user.findFirst({ where: { email: "ai-support@handa.internal" } });
  if (!u) {
    u = await prisma.user.create({
      data: { name: "Handa Support (AI)", email: "ai-support@handa.internal", isGuest: true, status: "ACTIVE" },
    });
  }
  return u;
}

// Finds-or-creates the caller's SUPPORT thread. With no contextId, this is
// the one persistent general "Chat with Support" thread for the account
// (contextId = the user's own id) -- unchanged behavior for the
// Profile-menu entry point, which isn't about any specific booking.
// With a contextId (a bookingId/shopSessionId), it's a real thread scoped
// to that one booking/session -- opening "Chat with Support" from two
// different bookings now gets two real, separate threads, and
// closeSupportThreadForContext (below) closes the right one when that
// booking/session finishes, instead of every booking sharing one
// lifetime-of-the-account thread.
async function openSupportThread(req, res, next) {
  try {
    const contextId = req.body?.contextId || req.user.id;
    let thread = await prisma.chatThread.findFirst({ where: { contextType: "SUPPORT", contextId } });
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { contextType: "SUPPORT", contextId, participants: { create: [{ userId: req.user.id }] } },
      });
    }
    res.status(201).json({ thread });
  } catch (err) {
    next(err);
  }
}

// Called once a booking/shop-session this ticket's contextId points at
// reaches a terminal state (COMPLETED/CANCELLED) -- system-closes any
// SUPPORT thread scoped to it (closedBy stays null: nobody in particular
// closed it, the booking itself ended). A no-op if no such thread exists
// or it's already closed. Never throws -- callers fire-and-forget this
// alongside their real completion/cancellation logic.
async function closeSupportThreadForContext(contextId) {
  try {
    const thread = await prisma.chatThread.findFirst({ where: { contextType: "SUPPORT", contextId } });
    if (!thread || thread.closedAt) return;
    await prisma.chatThread.update({ where: { id: thread.id }, data: { closedAt: new Date() } });
  } catch (err) {
    // best-effort -- a booking's own completion must never fail because a
    // support-chat cleanup step threw
  }
}

// Fires after a real customer message lands in a SUPPORT thread no admin
// has taken over yet -- generates one real AI reply (credential-gated;
// silently skipped if no key is configured, since a human admin will pick
// the thread up from the admin panel regardless).
async function maybeSendAiReply(threadId, senderUserId, io) {
  const thread = await prisma.chatThread.findUnique({ where: { id: threadId } });
  if (!thread || thread.contextType !== "SUPPORT" || thread.handledByAdminId) return;
  const aiUser = await ensureAiSupportUser();
  if (senderUserId === aiUser.id) return;

  const recent = await prisma.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" }, take: 20 });
  const history = recent.map((m) => ({ role: m.senderId === aiUser.id ? "assistant" : "user", text: m.body }));

  let replyText;
  try {
    replyText = await aiChatSvc.getSupportReply(senderUserId, history);
  } catch (err) {
    return;
  }

  // Re-check right before writing -- the AI network call above can take
  // several seconds, a real enough window for an admin to send their own
  // reply (stamping handledByAdminId) while this was in flight. Without
  // this, the AI's reply could still land after a human already took over.
  const stillUnhandled = await prisma.chatThread.findUnique({ where: { id: threadId }, select: { handledByAdminId: true } });
  if (!stillUnhandled || stillUnhandled.handledByAdminId) return;

  const aiMessage = await prisma.chatMessage.create({ data: { threadId, senderId: aiUser.id, body: replyText } });
  io?.to(`chat:${threadId}`).emit("chat:message", aiMessage);
  await notify(io, senderUserId, "CHAT", "Support replied", replyText.slice(0, 120), { threadId }).catch(() => {});

  // Real-time nudge to every connected admin (see live.js's "admins" room
  // join) the moment the AI actually replies -- not just when the user's
  // own message lands -- so an admin can see what the AI is saying and
  // decide whether to jump into the conversation themselves.
  const sender = await prisma.user.findUnique({ where: { id: senderUserId }, select: { name: true } }).catch(() => null);
  io?.to("admins").emit("chat:ai-replied", { threadId, userName: sender ? sender.name : "a user", preview: replyText });
}

// Finds an existing thread for this context (order/booking/session/support)
// or a direct 1:1 pair, or creates one — the frontend's various chat
// entry points (order chat, live-shopping chat, vendor messages, generic
// support chat) all resolve to "get or create the thread for X".
async function openThread(req, res, next) {
  try {
    const { contextType, contextId, participantIds } = req.body;
    if (!contextType) return res.status(400).json({ error: "contextType is required." });

    const allParticipantIds = Array.from(new Set([req.user.id, ...(participantIds || [])]));
    if (allParticipantIds.length < 2) return res.status(400).json({ error: "At least one other participant is required." });

    // Scoped to the current user being a participant — contextId alone
    // isn't unique per conversation (e.g. a vendor's profile id is the
    // same for every customer who chats with them), so without this a
    // second customer's lookup would land on the first customer's thread
    // and then 404 on every message fetch (never actually added as a
    // participant of it).
    let thread = contextId
      ? await prisma.chatThread.findFirst({
          where: { contextType, contextId, participants: { some: { userId: req.user.id } } },
          include: { participants: true },
        })
      : null;

    if (!thread) {
      thread = await prisma.chatThread.create({
        data: {
          contextType,
          contextId,
          participants: { create: allParticipantIds.map((userId) => ({ userId })) },
        },
        include: { participants: true },
      });
    }

    res.status(201).json({ thread });
  } catch (err) {
    next(err);
  }
}

async function listThreads(req, res, next) {
  try {
    const threads = await prisma.chatThread.findMany({
      where: { participants: { some: { userId: req.user.id } } },
      include: {
        participants: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ threads });
  } catch (err) {
    next(err);
  }
}

async function assertParticipant(threadId, userId) {
  const participant = await prisma.chatParticipant.findUnique({ where: { threadId_userId: { threadId, userId } } });
  if (!participant) {
    const err = new Error("Thread not found.");
    err.status = 404;
    throw err;
  }
  return participant;
}

async function listMessages(req, res, next) {
  try {
    await assertParticipant(req.params.id, req.user.id);
    const [thread, messages] = await Promise.all([
      prisma.chatThread.findUnique({ where: { id: req.params.id } }),
      prisma.chatMessage.findMany({ where: { threadId: req.params.id }, orderBy: { createdAt: "asc" }, take: 200 }),
    ]);
    await prisma.chatParticipant.update({
      where: { threadId_userId: { threadId: req.params.id, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });
    res.json({ messages, thread });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    await assertParticipant(req.params.id, req.user.id);
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, select: { closedAt: true } });
    if (thread?.closedAt) return res.status(409).json({ error: "This chat has ended." });
    const { body, attachmentUrl } = req.body;
    if ((!body || !body.trim()) && !attachmentUrl) return res.status(400).json({ error: "Message body or attachment is required." });

    const message = await prisma.chatMessage.create({
      data: { threadId: req.params.id, senderId: req.user.id, body: body || "", attachmentUrl },
    });

    const io = req.app.get("io");
    // Carries the sender's own name/role alongside the raw message row --
    // lets the recipient's client show a real "X (role) wants to chat with
    // you" prompt instead of only a background bell notification, without
    // a second round-trip to look the sender up.
    io?.to(`chat:${req.params.id}`).emit("chat:message", { ...message, senderName: req.user.name, senderRole: req.user.role });

    const notifyText = body && body.trim() ? body.slice(0, 120) : "📎 Sent a photo";
    const others = await prisma.chatParticipant.findMany({ where: { threadId: req.params.id, userId: { not: req.user.id } } });
    for (const p of others) {
      await notify(io, p.userId, "CHAT", "New message", notifyText, { threadId: req.params.id });
    }

    res.status(201).json({ message });

    maybeSendAiReply(req.params.id, req.user.id, io).catch(() => {});
  } catch (err) {
    next(err);
  }
}

// Real evidence/proof upload for a chat thread (e.g. a dispute discussion
// in the account's own SUPPORT thread) — returns a URL only; the frontend
// then calls sendMessage with that URL as attachmentUrl so it goes through
// the normal message/notify/AI-reply pipeline like any other message.
async function uploadChatAttachment(req, res, next) {
  try {
    await assertParticipant(req.params.id, req.user.id);
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  } catch (err) {
    next(err);
  }
}

module.exports = { openThread, listThreads, listMessages, sendMessage, openSupportThread, closeSupportThreadForContext, uploadChatAttachment };
