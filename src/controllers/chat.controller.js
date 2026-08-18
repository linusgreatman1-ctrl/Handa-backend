const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

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

    let thread = contextId
      ? await prisma.chatThread.findFirst({ where: { contextType, contextId }, include: { participants: true } })
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
  } catch (err) {
    next(err);
  }
}

module.exports = { openThread, listThreads, listMessages, sendMessage };
