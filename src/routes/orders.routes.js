const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/orders.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createOrder);
router.get("/", ctrl.listOrders);
router.get("/:id", ctrl.getOrder);

router.post("/:id/accept", ctrl.acceptOrder);
router.post("/:id/decline", ctrl.declineOrder);
router.post("/:id/ready", ctrl.markReady);

router.post("/:id/accept-delivery", ctrl.acceptDelivery);
router.post("/:id/picked-up", ctrl.markPickedUp);
router.post("/:id/delivered", ctrl.markDelivered);

router.post("/:id/confirm", ctrl.confirmOrder);
router.post("/:id/cancel", ctrl.cancelOrder);

module.exports = router;
