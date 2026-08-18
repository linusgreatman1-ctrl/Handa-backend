const express = require("express");
const { requireAuth, requireRole, requireVendorProfile } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");

const router = express.Router();

// Paystack POSTs here with no auth header — signature verification inside
// the controller is what authenticates this route instead.
router.post("/webhook", ctrl.webhook);

router.use(requireAuth);
router.post("/wallet/deposit/initialize", ctrl.initializeWalletDeposit);
router.get("/verify/:reference", ctrl.verifyPayment);
router.post("/commission/:id/initialize", requireRole("VENDOR"), requireVendorProfile, ctrl.initializeCommissionPayment);
router.post("/feature-boost/initialize", requireRole("VENDOR"), requireVendorProfile, ctrl.initializeFeatureBoostPayment);

module.exports = router;
