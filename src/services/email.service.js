// Real SMTP email sending for admin outreach (bulk email, single-user
// email) — same pattern as africastalking.service.js/paystack.service.js:
// requires real credentials to be set, throws a clear 503 in their
// absence rather than a silent fake success. Uses nodemailer against any
// standard SMTP provider (Gmail, SendGrid, Mailgun, etc.) via env vars,
// rather than binding to one vendor's proprietary API.
const nodemailer = require("nodemailer");

let cachedTransport = null;

function requireConfig() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) {
    const err = new Error("Email is not configured (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS).");
    err.status = 503;
    throw err;
  }
  return { host, port: parseInt(port, 10), user, pass };
}

function getTransport() {
  if (cachedTransport) return cachedTransport;
  const { host, port, user, pass } = requireConfig();
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return cachedTransport;
}

// Sends one email. Throws on failure — callers doing a bulk send should
// catch per-recipient so one bad address doesn't abort the whole batch.
async function sendEmail(to, subject, html, text) {
  const transport = getTransport();
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  await transport.sendMail({ from, to, subject, html, text: text || undefined });
}

module.exports = { sendEmail, requireConfig };
