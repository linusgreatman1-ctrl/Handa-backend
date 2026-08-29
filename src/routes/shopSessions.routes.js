const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/shopSessions.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createSession);
router.get("/", ctrl.listSessions);
router.get("/:id", ctrl.getSession);

router.post("/:id/items", ctrl.addItem);
router.post("/:id/items/mid-call", ctrl.addItemMidCall);
router.patch("/:id/items/:itemId/price", ctrl.priceItem);
router.post("/:id/items/:itemId/approve", ctrl.approveItem);
router.post("/:id/items/:itemId/reset-pricing", ctrl.resetItemPricing);
router.delete("/:id/items/:itemId", ctrl.removeItem);

router.post("/:id/pay", ctrl.paySession);
router.post("/:id/topup-items", ctrl.topUpItems);
router.post("/:id/match", ctrl.matchSession);
router.post("/:id/start-call", ctrl.startCall);
router.post("/:id/call-pause", ctrl.pauseCall);
router.post("/:id/call-resume", ctrl.resumeCall);
router.post("/:id/packaging", ctrl.startPackaging);
router.post("/:id/pay-call-topup", ctrl.payCallTopUp);
router.post("/:id/emergency-end", ctrl.requestEmergencyEnd);
router.post("/:id/emergency-end/confirm", ctrl.confirmEmergencyEnd);
router.post("/:id/find-rider", ctrl.findRider);
router.post("/:id/pay-rider-fee-topup", ctrl.payRiderFeeTopUp);
router.post("/:id/accept-delivery", ctrl.acceptDelivery);
router.post("/:id/rider-arrived-shopper", ctrl.riderArrivedShopper);
router.post("/:id/out-for-delivery", ctrl.markOutForDelivery);
router.post("/:id/confirm-call/start", ctrl.startConfirmCall);
router.post("/:id/confirm-call/complete", ctrl.completeConfirmCall);
router.post("/:id/handover-confirmed", ctrl.confirmHandover);
router.post("/:id/rider-arrived-customer", ctrl.riderArrivedCustomer);
router.post("/:id/delivered", ctrl.markDelivered);
router.post("/:id/confirm", ctrl.confirmSession);
router.post("/:id/cancel", ctrl.cancelSession);
router.post("/:id/seller-payouts", ctrl.confirmSellerPayouts);
router.post("/:id/sos", ctrl.sendSOS);

module.exports = router;
