const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/bookings.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createBooking);
router.get("/", ctrl.listBookings);
router.get("/:id", ctrl.getBooking);
router.patch("/:id", ctrl.updateBooking);
router.post("/:id/accept", ctrl.acceptBooking);
router.post("/:id/decline", ctrl.declineBooking);
router.post("/:id/pay", ctrl.payBooking);
router.post("/:id/complete", ctrl.completeBooking);
router.post("/:id/cancel", ctrl.cancelBooking);

module.exports = router;
