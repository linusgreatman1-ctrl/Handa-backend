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
  const json = await res.json();
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
  return atFetch(SMS_BASE, body);
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

module.exports = { sendSms, initiateCall };
