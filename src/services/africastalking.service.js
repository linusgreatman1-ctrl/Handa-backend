// Thin wrapper around Africa's Talking's SMS + Voice REST APIs — the one
// provider that covers both "send an SMS" and "place a call" for Nigerian
// numbers under a single account, matching the two admin outreach actions
// this service backs. Same pattern as paystack.service.js: every call
// requires real credentials to be set, and throws a clear 503 in their
// absence rather than a silent fake success.
const SMS_BASE = "https://api.africastalking.com/version1/messaging";
const VOICE_BASE = "https://voice.africastalking.com/call";

function requireCreds() {
  const apiKey = process.env.AFRICASTALKING_API_KEY;
  const username = process.env.AFRICASTALKING_USERNAME;
  if (!apiKey || !username) {
    const err = new Error("Africa's Talking is not configured (AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME).");
    err.status = 503;
    throw err;
  }
  return { apiKey, username };
}

async function atFetch(url, body) {
  const { apiKey } = requireCreds();
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  // Africa's Talking returns JSON on success, but auth/validation failures
  // (e.g. "The supplied authentication is invalid") come back as plain
  // text — res.json() throws SyntaxError on those, which would otherwise
  // surface as an opaque 500 with no useful message.
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    const err = new Error(raw.trim() || "Africa's Talking request failed.");
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json.SMSMessageData?.Message || json.errorMessage || "Africa's Talking request failed.");
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  return json;
}

// Sends a single SMS to a real phone number (E.164 format, e.g. +2348010000001).
async function sendSms(toPhone, message) {
  const { username } = requireCreds();
  const senderId = process.env.AFRICASTALKING_SENDER_ID;
  const body = { username, to: toPhone, message };
  if (senderId) body.from = senderId;
  const result = await atFetch(SMS_BASE, body);
  // A 2xx HTTP response only means Africa's Talking accepted the request —
  // actual delivery is reported per-recipient and can still fail (e.g.
  // insufficient balance, invalid number), which would otherwise look like
  // a silent success to the caller.
  const recipient = result.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status !== "Success") {
    const err = new Error(`SMS not delivered: ${recipient.status}`);
    err.status = 502;
    throw err;
  }
  return result;
}

// Places an outbound call from the account's Africa's Talking virtual
// number to the target phone — once answered, Africa's Talking calls back
// to our /voice/callback webhook for instructions (see voice.controller.js),
// which bridges the call to AFRICASTALKING_SUPPORT_NUMBER so an admin can
// actually speak to the person, not just ring their phone.
async function initiateCall(toPhone) {
  const { username } = requireCreds();
  const fromNumber = process.env.AFRICASTALKING_VOICE_NUMBER;
  if (!fromNumber) {
    const err = new Error("AFRICASTALKING_VOICE_NUMBER is not configured.");
    err.status = 503;
    throw err;
  }
  return atFetch(VOICE_BASE, { username, from: fromNumber, to: toPhone });
}

// Exported so a caller (e.g. bulk SMS) can fail fast with a clean 503
// before doing any DB/loop work, same as email.service.js's requireConfig.
function requireConfig() {
  requireCreds();
}

module.exports = { sendSms, initiateCall, requireConfig };
