// Thin wrapper around a chat-completion AI provider (default: Gemini) for
// the Support chat auto-reply. Same pattern as africastalking.service.js:
// requires a real API key and throws a clear 503 in its absence rather
// than a silent fake reply. AI_PROVIDER is swappable so a different
// provider can be added later without touching the call sites.
const prisma = require("../config/db");

const DEFAULT_PROVIDER = "GEMINI";
const GEMINI_MODEL = "gemini-1.5-flash";

function requireCreds() {
  const provider = (process.env.AI_PROVIDER || DEFAULT_PROVIDER).toUpperCase();
  if (provider === "GEMINI") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("AI chat is not configured (GEMINI_API_KEY).");
      err.status = 503;
      throw err;
    }
    return { provider, apiKey };
  }
  const err = new Error(`AI_PROVIDER "${provider}" is not supported.`);
  err.status = 503;
  throw err;
}

const SUPPORT_SYSTEM_PROMPT =
  "You are Handa Support, a helpful assistant for Handa — a Nigerian marketplace app for Shop-For-Me grocery runs, Home Cook meal bookings, and Event Planner bookings. " +
  "Answer briefly and plainly (2-4 sentences). If the question needs a human (refunds, disputes, account issues), say a human admin will follow up shortly. Never invent order/payment details you don't have.";

async function geminiGenerate(apiKey, historyMessages) {
  const fetch = (await import("node-fetch")).default;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const contents = historyMessages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: SUPPORT_SYSTEM_PROMPT }] } }),
  });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    const err = new Error(raw.trim() || "AI chat request failed.");
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json.error?.message || "AI chat request failed.");
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text.trim()) {
    const err = new Error("AI provider returned an empty reply.");
    err.status = 502;
    throw err;
  }
  return text.trim();
}

// historyMessages: [{role:'user'|'assistant', text}], oldest first, latest
// user message last. Logs every real exchange to AiConversationLog so the
// admin panel's already-built "AI Conversations" viewer has real data.
async function getSupportReply(userId, historyMessages) {
  const { provider, apiKey } = requireCreds();
  const lastUserMsg = [...historyMessages].reverse().find((m) => m.role === "user");
  const reply = await geminiGenerate(apiKey, historyMessages);
  await prisma.aiConversationLog
    .create({ data: { userId, prompt: lastUserMsg ? lastUserMsg.text : "", response: reply, provider } })
    .catch(() => {}); // logging must never break the real reply
  return reply;
}

module.exports = { getSupportReply };
