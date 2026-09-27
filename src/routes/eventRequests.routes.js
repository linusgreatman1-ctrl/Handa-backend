const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/eventRequests.controller");
const negotiation = require("../utils/proposalNegotiation");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createEventRequest);
router.get("/", ctrl.listEventRequests);
router.get("/:id", ctrl.getEventRequest);
router.post("/:id/proposals", ctrl.submitProposal);
router.post("/:id/proposals/:proposalId/accept", ctrl.acceptProposal);
router.post("/:id/proposals/:proposalId/decline", ctrl.declineProposal);
router.post("/:id/proposals/:proposalId/counter", negotiation.counter("event"));
router.post("/:id/proposals/:proposalId/accept-offer", negotiation.acceptOffer("event"));
router.post("/:id/cancel", ctrl.cancelEventRequest);

module.exports = router;
