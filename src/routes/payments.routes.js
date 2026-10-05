const express = require("express");
const { requireAuth, requireVendorProfile } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");

const router = express.Router();

// Paystack POSTs here with no auth header — signature verification inside
// the controller is what authenticates this route instead.
router.post("/webhook", ctrl.webhook); // Paystack
// Flutterwave -- authenticated by its verif-hash header inside the controller.
router.post("/webhook/flutterwave", ctrl.flutterwaveWebhook);

// Test-mode Card/USSD checkout (see paystack.service.js devCheckoutEnabled).
// Opened in a new tab like Paystack's hosted page, so no auth header --
// the unguessable reference is the only key, and it only exists at all
// while DEV_BYPASS_PAYMENTS is on with no real Paystack key.
const paystackSvc = require("../services/paystack.service");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function devCheckoutPage(res, title, body) {
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#111;color:#F2EDE8;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{background:#1C1C1C;border:1.5px solid #2A2850;border-radius:18px;padding:26px 20px;max-width:380px;width:100%;text-align:center}
.t{display:inline-block;background:rgba(245,166,35,.12);color:#F5A623;border-radius:20px;padding:4px 12px;font-size:11px;font-weight:700;margin-bottom:14px}
.a{font-size:30px;font-weight:900;margin:8px 0 4px}.m{color:#9A9390;font-size:13px;line-height:1.5}
button{width:100%;margin-top:18px;padding:14px;border:none;border-radius:12px;background:#2ECC71;color:#111;font-weight:800;font-size:15px;cursor:pointer}</style></head>
<body><div class="c">${body}</div></body></html>`);
}
router.get("/dev-checkout/:reference", (req, res) => {
  const t = paystackSvc.devCheckoutEnabled() && paystackSvc.getDevTransaction(req.params.reference);
  if (!t) return res.status(404).send("Not found");
  const naira = "₦" + Math.round(t.amount / 100).toLocaleString();
  if (t.status !== "pending") {
    return devCheckoutPage(res, "Payment complete", `<div class="t">TEST MODE</div><div style="font-size:48px">✅</div><div class="a">${naira}</div><div class="m">Payment successful. You can close this tab and return to Handa.</div>`);
  }
  devCheckoutPage(res, "Handa Checkout", `<div class="t">TEST MODE — no real money</div><div style="font-size:40px">💳</div>
<div class="a">${naira}</div><div class="m">Card / USSD test payment for ${esc(t.email || "your account")}</div>
<form method="post" action="/api/payments/dev-checkout/${encodeURIComponent(req.params.reference)}/pay"><button type="submit">Pay ${naira}</button></form>`);
});
router.post("/dev-checkout/:reference/pay", async (req, res, next) => {
  try {
    const ref = req.params.reference;
    const t = paystackSvc.devCheckoutEnabled() && paystackSvc.getDevTransaction(ref);
    if (!t) return res.status(404).send("Not found");
    if (t.status === "pending") {
      paystackSvc.markDevTransactionPaid(ref);
      // Applied exactly once, right here; later verify polls see "applied"
      // (not "success") so they can never apply it a second time.
      await ctrl.confirmAndApply(ref, req.app.get("io")); // applied exactly once
    }
    res.redirect(303, `/api/payments/dev-checkout/${encodeURIComponent(ref)}`);
  } catch (err) {
    next(err);
  }
});

// Flutterwave sends the customer back here after its hosted checkout:
// confirm the payment, apply it (once), and show a "go back to Handa" page.
router.get("/return", async (req, res) => {
  let ok = false;
  try {
    const ref = String(req.query.tx_ref || "");
    if (ref) ok = (await ctrl.confirmAndApply(ref, req.app.get("io"))).paid;
  } catch (e) {
    ok = false;
  }
  devCheckoutPage(res, ok ? "Payment successful" : "Payment not completed", ok
    ? '<div style="font-size:48px">✅</div><div class="a">Payment successful</div><div class="m">Your payment is safely in Handa escrow. You can close this tab and return to Handa.</div>'
    : '<div style="font-size:44px">⚠️</div><div class="a" style="font-size:22px">Payment not completed</div><div class="m">No money was taken, or it is still being confirmed. Close this tab and return to Handa to check or try again.</div>');
});

router.use(requireAuth);
// Which payment methods can actually go through right now -- Card/USSD need
// Paystack configured; the escrow sheet hides whatever can't succeed
// instead of offering a method that's guaranteed to fail.
// gateways: which card/USSD gateways the customer can choose between.
const gatewaySvc = require("../services/paymentGateway.service");
router.get("/methods", (req, res) => {
  const g = gatewaySvc.available();
  const card = g.paystack || g.flutterwave || gatewaySvc.devCheckoutEnabled(); // test checkout counts in test mode
  res.json({ wallet: true, bankTransfer: true, card, ussd: card, gateways: g });
});
router.post("/wallet/deposit/initialize", ctrl.initializeWalletDeposit);
router.get("/verify/:reference", ctrl.verifyPayment);
router.get("/manual-request/:id", ctrl.getManualPaymentRequest);
router.post("/manual-request/:id/dev-confirm", ctrl.confirmManualPaymentDev);
router.post("/commission/:id/initialize", requireVendorProfile, ctrl.initializeCommissionPayment);
router.post("/feature-boost/initialize", requireVendorProfile, ctrl.initializeFeatureBoostPayment);

module.exports = router;
