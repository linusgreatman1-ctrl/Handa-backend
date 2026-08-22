const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/shopSessions.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createSession);
router.get("/", ctrl.listSessions);
router.get("/:id", ctrl.getSession);

router.post("/:id/items", ctrl.addItem);
router.patch("/:id/items/:itemId/price", ctrl.priceItem);
router.post("/:id/items/:itemId/approve", ctrl.approveItem);
router.delete("/:id/items/:itemId", ctrl.removeItem);

router.post("/:id/pay", ctrl.paySession);
router.post("/:id/match", ctrl.matchSession);
router.post("/:id/start-call", ctrl.startCall);
router.post("/:id/packaging", ctrl.startPackaging);
router.post("/:id/pay-call-topup", ctrl.payCallTopUp);
router.post("/:id/find-rider", ctrl.findRider);
router.post("/:id/pay-rider-fee-topup", ctrl.payRiderFeeTopUp);
router.post("/:id/accept-delivery", ctrl.acceptDelivery);
router.post("/:id/out-for-delivery", ctrl.markOutForDelivery);
router.post("/:id/delivered", ctrl.markDelivered);
router.post("/:id/confirm", ctrl.confirmSession);
router.post("/:id/cancel", ctrl.cancelSession);
router.post("/:id/seller-payouts", ctrl.confirmSellerPayouts);

module.exports = router;
