const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/support.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/tickets", ctrl.createTicket);
router.get("/tickets", ctrl.listMyTickets);
router.get("/tickets/all", requireRole("ADMIN"), ctrl.listAllTickets);
router.get("/tickets/:id", ctrl.getTicket);
router.post("/tickets/:id/evidence", upload.single("evidence"), ctrl.uploadEvidence);
router.post("/tickets/:id/second-party-evidence", upload.single("evidence"), ctrl.uploadSecondPartyEvidence);
router.post("/tickets/:id/respond", ctrl.respondToTicket);
router.post("/tickets/:id/chat", ctrl.openMyDisputeChat);
router.patch("/tickets/:id", requireRole("ADMIN"), ctrl.updateTicketStatus);

module.exports = router;
