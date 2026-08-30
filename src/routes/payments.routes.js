const express = require("express");
const { requireAuth, requireVendorProfile } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");

const router = express.Router();

// Paystack POSTs here with no auth header — signature verification inside
// the controller is what authenticates this route instead.
router.post("/webhook", ctrl.webhook);

router.use(requireAuth);
router.post("/wallet/deposit/initialize", ctrl.initializeWalletDeposit);
router.get("/verify/:reference", ctrl.verifyPayment);
router.get("/manual-request/:id", ctrl.getManualPaymentRequest);
router.post("/manual-request/:id/dev-confirm", ctrl.confirmManualPaymentDev);
router.post("/commission/:id/initialize", requireVendorProfile, ctrl.initializeCommissionPayment);
router.post("/feature-boost/initialize", requireVendorProfile, ctrl.initializeFeatureBoostPayment);

module.exports = router;
