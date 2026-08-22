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

// Finds-or-creates the caller's own SUPPORT thread -- one per user
// (contextId = the user's own id keeps it unique and easy to look up),
// with only the caller as a real participant. Admins become participants
// only once they actually reply (see admin.controller.js's
// sendAdminChatMessage) -- until then they view via admin-only routes
// that read threads directly, not through ChatParticipant.
async function openSupportThread(req, res, next) {
  try {
    let thread = await prisma.chatThread.findFirst({ where: { contextType: "SUPPORT", contextId: req.user.id } });
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { contextType: "SUPPORT", contextId: req.user.id, participants: { create: [{ userId: req.user.id }] } },
      });
    }
    res.status(201).json({ thread });
  } catch (err) {
    next(err);
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

  const aiMessage = await prisma.chatMessage.create({ data: { threadId, senderId: aiUser.id, body: replyText } });
  io?.to(`chat:${threadId}`).emit("chat:message", aiMessage);
  await notify(io, senderUserId, "CHAT", "Support replied", replyText.slice(0, 120), { threadId }).catch(() => {});
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
    const messages = await prisma.chatMessage.findMany({
      where: { threadId: req.params.id },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    await prisma.chatParticipant.update({
      where: { threadId_userId: { threadId: req.params.id, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });
    res.json({ messages });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    await assertParticipant(req.params.id, req.user.id);
    const { body, attachmentUrl } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message body is required." });

    const message = await prisma.chatMessage.create({
      data: { threadId: req.params.id, senderId: req.user.id, body, attachmentUrl },
    });

    const io = req.app.get("io");
    io?.to(`chat:${req.params.id}`).emit("chat:message", message);

    const others = await prisma.chatParticipant.findMany({ where: { threadId: req.params.id, userId: { not: req.user.id } } });
    for (const p of others) {
      await notify(io, p.userId, "CHAT", "New message", body.slice(0, 120), { threadId: req.params.id });
    }

    res.status(201).json({ message });

    maybeSendAiReply(req.params.id, req.user.id, io).catch(() => {});
  } catch (err) {
    next(err);
  }
}

module.exports = { openThread, listThreads, listMessages, sendMessage, openSupportThread };
