const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/cakeRequests.controller");
const negotiation = require("../utils/proposalNegotiation");

const router = express.Router();
router.use(requireAuth);

// Up to 5 reference photos of the cake style/design the customer wants.
router.post("/", upload.array("photos", 5), ctrl.createCakeRequest);
router.get("/", ctrl.listCakeRequests);
router.get("/:id", ctrl.getCakeRequest);
router.post("/:id/proposals", ctrl.submitProposal);
router.post("/:id/proposals/:proposalId/accept", ctrl.acceptProposal);
router.post("/:id/proposals/:proposalId/decline", ctrl.declineProposal);
router.post("/:id/proposals/:proposalId/counter", negotiation.counter("cake"));
router.post("/:id/proposals/:proposalId/accept-offer", negotiation.acceptOffer("cake"));
router.post("/:id/cancel", ctrl.cancelCakeRequest);

module.exports = router;
