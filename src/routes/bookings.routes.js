const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/bookings.controller");

const router = express.Router();
router.use(requireAuth);

// Money visibility on a CAKE order, applied to every booking this router
// returns: the customer sees everything (cake + rider fee + total), the
// baker only their own cake amount, the rider only their delivery fee.
// Done once here, on the way out, so no endpoint can leak the other
// party's share.
function cakeViewFor(user, b) {
  if (!b || b.type !== "CAKE" || b.customerId === user.id) return b;
  const riderFee = b.riderFeeKobo || 0;
  if (user.vendorProfile && b.vendorId === user.vendorProfile.id) {
    const { riderFeeKobo, ...rest } = b;
    return { ...rest, totalKobo: (b.totalKobo || 0) - riderFee };
  }
  if (user.riderProfile) {
    const { totalKobo, ...rest } = b;
    return { ...rest, selectedItems: Array.isArray(b.selectedItems) ? b.selectedItems.map((i) => ({ name: i.name, qty: i.qty })) : b.selectedItems };
  }
  return b;
}
router.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && req.user && typeof body === "object") {
      if (body.booking) body = { ...body, booking: cakeViewFor(req.user, body.booking) };
      if (Array.isArray(body.bookings)) body = { ...body, bookings: body.bookings.map((b) => cakeViewFor(req.user, b)) };
    }
    return json(body);
  };
  next();
});

router.post("/", ctrl.createBooking);
router.get("/", ctrl.listBookings);
// Must come before GET /:id -- otherwise "cake-deliveries" would match :id.
router.get("/cake-deliveries/available", ctrl.listAvailableCakeDeliveries);
router.get("/cake-delivery-fee", ctrl.getCakeDeliveryFee);
router.get("/:id", ctrl.getBooking);
router.patch("/:id", ctrl.updateBooking);
router.post("/:id/accept-edit", ctrl.acceptEditedBooking);
router.post("/:id/decline-edit", ctrl.declineEditedBooking);
router.post("/:id/accept", ctrl.acceptBooking);
router.post("/:id/decline", ctrl.declineBooking);
router.post("/:id/pay", ctrl.payBooking);
router.post("/:id/start-job", ctrl.startBookingJob);
router.post("/:id/engage", ctrl.engageBooking);
router.post("/:id/end-conversation", ctrl.endBookingConversation);
router.post("/:id/release-payment", ctrl.releaseBookingPayment);
router.post("/:id/request-additional-payment", ctrl.requestAdditionalPayment);
router.post("/:id/respond-additional-payment", ctrl.respondAdditionalPayment);
router.post("/:id/complete", ctrl.completeBooking);
router.post("/:id/confirm-complete", ctrl.confirmBookingCompletion);
router.post("/:id/cancel", ctrl.cancelBooking);

// CAKE rider delivery
router.post("/:id/mark-ready", ctrl.markCakeReady);
router.post("/:id/search-rider", ctrl.searchCakeRider);
router.post("/:id/accept-delivery", ctrl.acceptCakeDelivery);
router.post("/:id/rider-arrived-vendor", ctrl.riderArrivedAtCakeVendor);
router.post("/:id/confirm-pickup", ctrl.confirmCakePickup);
router.post("/:id/rider-arrived-customer", ctrl.riderArrivedAtCakeCustomer);
router.post("/:id/confirm-delivery", ctrl.confirmCakeDelivery);

module.exports = router;
