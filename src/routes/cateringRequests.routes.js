const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/cateringRequests.controller");
const negotiation = require("../utils/proposalNegotiation");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.createCateringRequest);
router.get("/", ctrl.listCateringRequests);
router.get("/:id", ctrl.getCateringRequest);
router.post("/:id/proposals", ctrl.submitProposal);
router.post("/:id/proposals/:proposalId/accept", ctrl.acceptProposal);
router.post("/:id/proposals/:proposalId/decline", ctrl.declineProposal);
router.post("/:id/proposals/:proposalId/counter", negotiation.counter("catering"));
router.post("/:id/proposals/:proposalId/accept-offer", negotiation.acceptOffer("catering"));
router.post("/:id/cancel", ctrl.cancelCateringRequest);

module.exports = router;
