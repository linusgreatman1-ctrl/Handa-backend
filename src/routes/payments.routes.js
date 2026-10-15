const express = require("express");
const { requireAuth, requireVendorProfile } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");

const router = express.Router();

// Paystack POSTs here with no auth header — signature verification inside
// the controller is what authenticates this route instead.
router.post("/webhook", ctrl.webhook); // Paystack
// Flutterwave -- authenticated by its verif-hash header inside the controller.
router.post("/webhook/flutterwave", ctrl.flutterwaveWebhook);
// Money arriving in the company account: confirms the matching bank-transfer request by itself.
router.post("/webhook/bank-credit", ctrl.bankCreditWebhook);

// Checkout pages (test checkout + the page real gateways return to). Each
// has a back arrow and a "Return to Handa" button: if the checkout was
// opened as its own tab it closes, otherwise it goes back into the app
// (/app/#payment-return=REF), which picks the payment up from there.
const paystackSvc = require("../services/paystack.service");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function devCheckoutPage(res, title, body, ref, backStatus) {
  backStatus = backStatus || "done";
  const back = "/app/#payment-return=" + encodeURIComponent(ref || "");
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" type="image/svg+xml" href="/app/favicon.svg">
<style>body{margin:0;background:#111;color:#F2EDE8;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{position:relative;background:#1C1C1C;border:1.5px solid #2A2850;border-radius:18px;padding:26px 20px;max-width:380px;width:100%;text-align:center}
.bk{position:absolute;top:12px;left:12px;width:38px;height:38px;border-radius:11px;border:1.5px solid #2A2850;background:#242424;color:#F2EDE8;font-size:18px;cursor:pointer;margin:0;padding:0}
.t{display:inline-block;background:rgba(245,166,35,.12);color:#F5A623;border-radius:20px;padding:4px 12px;font-size:11px;font-weight:700;margin-bottom:14px}
.a{font-size:30px;font-weight:900;margin:8px 0 4px}.m{color:#9A9390;font-size:13px;line-height:1.5}
label{display:block;text-align:left;font-size:11px;color:#9A9390;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 5px}
input,select{width:100%;box-sizing:border-box;padding:12px;border-radius:11px;border:1.5px solid #2A2850;background:#242424;color:#F2EDE8;font-size:15px}
.row{display:flex;gap:10px}.row>div{flex:1}
.code{font-family:monospace;font-size:22px;font-weight:800;color:#2ECC71;background:#242424;border-radius:12px;padding:14px;margin-top:12px;letter-spacing:1px}
.hint{font-size:11px;color:#9A9390;margin-top:8px;text-align:left}.err{color:#E8392E;font-size:12px;min-height:16px;margin-top:8px}
button{width:100%;margin-top:18px;padding:14px;border:none;border-radius:12px;background:#2ECC71;color:#111;font-weight:800;font-size:15px;cursor:pointer}
.sec{background:transparent;border:1.5px solid #2A2850;color:#9A9390;margin-top:10px;padding:11px;font-size:13px}</style></head>
<body><div class="c"><button class="bk" type="button" onclick="handaBack()" aria-label="Back">&#8592;</button>${body}</div>
<script>var HANDA_REF=${JSON.stringify(ref || "")};
// status: "cancelled" (back arrow / Cancel before paying) or "done".
function handaBack(status){status=status||${JSON.stringify(backStatus)};
// Inside the app's checkout panel: tell the app, which closes the panel and
// returns to the screen the customer was on.
try{if(window.parent&&window.parent!==window){window.parent.postMessage({type:'handa-checkout',status:status,ref:HANDA_REF},location.origin);return;}}catch(e){}
try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'handa-checkout',status:status,ref:HANDA_REF},location.origin);window.close();setTimeout(function(){location.href=${JSON.stringify(back)}+'&status='+status;},300);return;}}catch(e){}
location.href=${JSON.stringify(back)}+'&status='+status;}</script>
</body></html>`);
}
const RETURN_BTN = '<button type="button" onclick="handaBack(\'done\')">Return to Handa</button>';
// Main Nigerian banks and their USSD shortcodes.
const USSD_BANKS = [
  ["Access Bank", "*901*000*"], ["Ecobank", "*326*000*"], ["Fidelity Bank", "*770*000*"], ["First Bank", "*894*000*"],
  ["FCMB", "*329*000*"], ["Globus Bank", "*989*000*"], ["GTBank", "*737*000*"], ["Heritage Bank", "*745*000*"],
  ["Keystone Bank", "*7111*000*"], ["Polaris Bank", "*833*000*"], ["Stanbic IBTC", "*909*000*"], ["Standard Chartered", "*977*000*"],
  ["Sterling Bank", "*822*000*"], ["Titan Trust Bank", "*922*000*"], ["UBA", "*919*000*"], ["Union Bank", "*826*000*"],
  ["Unity Bank", "*7799*000*"], ["Wema Bank (ALAT)", "*945*000*"], ["Zenith Bank", "*966*000*"],
];

// Test-mode Card/USSD checkout (see paystack.service.js devCheckoutEnabled):
// only exists while DEV_BYPASS_PAYMENTS is on with no real gateway key. The
// card fields are only for the look of a real checkout -- nothing typed in
// them is sent anywhere (the inputs have no name, the form posts nothing).
router.get("/dev-checkout/:reference", (req, res) => {
  const ref = req.params.reference;
  const t = paystackSvc.devCheckoutEnabled() && paystackSvc.getDevTransaction(ref);
  if (!t) {
    return devCheckoutPage(res, "Checkout expired", '<div style="font-size:44px">⏳</div><div class="a" style="font-size:22px">This checkout has expired</div><div class="m">No money was taken. Go back to Handa and tap Pay again to start a new checkout.</div>' + RETURN_BTN.replace("'done'", "'cancelled'"), ref, "cancelled");
  }
  const naira = "₦" + Math.round(t.amount / 100).toLocaleString();
  if (t.status !== "pending") {
    return devCheckoutPage(res, "Payment complete", `<div class="t">TEST MODE</div><div style="font-size:48px">✅</div><div class="a">${naira}</div><div class="m">Payment successful — it is safely in Handa escrow.</div>` + RETURN_BTN, ref);
  }
  const action = `/api/payments/dev-checkout/${encodeURIComponent(ref)}/pay`;
  if (t.channel === "ussd") {
    const amt = Math.round(t.amount / 100);
    devCheckoutPage(res, "Pay with USSD", `<div class="t">TEST MODE — no real money</div><div style="font-size:40px">📱</div>
<div class="a">${naira}</div><div class="m">Pay with USSD for ${esc(t.email || "your account")}</div>
<label>Your bank</label><select id="bank" onchange="document.getElementById('code').textContent=this.value+'${amt}#'">${USSD_BANKS.map((b) => `<option value="${b[1]}">${b[0]}</option>`).join("")}</select>
<div class="code" id="code">${USSD_BANKS[0][1]}${amt}#</div>
<div class="hint">Dial this code on the phone number linked to your bank account, then follow the prompts. (Test mode: no need to actually dial.)</div>
<form method="post" action="${action}"><button type="submit">I've completed the USSD payment</button></form>
<button class="sec" type="button" onclick="handaBack('cancelled')">Cancel payment</button>`, ref, "cancelled");
    return;
  }
  devCheckoutPage(res, "Pay with card", `<div class="t">TEST MODE — no real money</div><div style="font-size:40px">💳</div>
<div class="a">${naira}</div><div class="m">Card payment for ${esc(t.email || "your account")}</div>
<form method="post" action="${action}" onsubmit="return checkCard()">
<label>Card number</label><input id="cn" inputmode="numeric" autocomplete="off" placeholder="0000 0000 0000 0000" value="4084 0840 8408 4081">
<div class="row"><div><label>Expiry (MM/YY)</label><input id="ex" inputmode="numeric" autocomplete="off" placeholder="MM/YY" value="12/30"></div>
<div><label>CVV</label><input id="cv" inputmode="numeric" autocomplete="off" placeholder="123" value="408" maxlength="4"></div></div>
<div class="hint">Test card filled in for you — nothing typed here is sent or stored.</div>
<div class="err" id="err"></div>
<button type="submit">Pay ${naira}</button></form>
<button class="sec" type="button" onclick="handaBack('cancelled')">Cancel payment</button>
<script>function checkCard(){var n=document.getElementById('cn').value.replace(/\\D/g,''),e=document.getElementById('ex').value,c=document.getElementById('cv').value.replace(/\\D/g,''),er=document.getElementById('err');
if(n.length<12||n.length>19){er.textContent='Enter a valid card number';return false;}
if(!/^(0[1-9]|1[0-2])\\/\\d{2}$/.test(e)){er.textContent='Enter the expiry as MM/YY';return false;}
if(c.length<3){er.textContent='Enter the 3-digit CVV';return false;}return true;}</script>`, ref, "cancelled");
});
router.post("/dev-checkout/:reference/pay", async (req, res, next) => {
  try {
    const ref = req.params.reference;
    const t = paystackSvc.devCheckoutEnabled() && paystackSvc.getDevTransaction(ref);
    if (!t) return res.redirect(303, `/api/payments/dev-checkout/${encodeURIComponent(ref)}`);
    if (t.status === "pending") {
      paystackSvc.markDevTransactionPaid(ref);
      await ctrl.confirmAndApply(ref, req.app.get("io")); // applied exactly once
    }
    res.redirect(303, `/api/payments/dev-checkout/${encodeURIComponent(ref)}`);
  } catch (err) {
    next(err);
  }
});

// Real gateways send the customer back here after their hosted checkout
// (Flutterwave: ?tx_ref=, Paystack: ?reference=): confirm the payment,
// apply it (once), and offer the way back into Handa.
router.get("/return", async (req, res) => {
  const ref = String(req.query.tx_ref || req.query.reference || req.query.trxref || "");
  let ok = false;
  try {
    if (ref) ok = (await ctrl.confirmAndApply(ref, req.app.get("io"))).paid;
  } catch (e) {
    ok = false;
  }
  devCheckoutPage(res, ok ? "Payment successful" : "Payment not completed", (ok
    ? '<div style="font-size:48px">✅</div><div class="a">Payment successful</div><div class="m">Your payment is safely in Handa escrow.</div>'
    : '<div style="font-size:44px">⚠️</div><div class="a" style="font-size:22px">Payment not completed</div><div class="m">No money was taken, or it is still being confirmed. Go back to Handa to check or try again.</div>') + (ok ? RETURN_BTN : RETURN_BTN.replace("'done'", "'cancelled'")), ref, ok ? "done" : "cancelled");
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
