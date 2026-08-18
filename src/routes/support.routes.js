const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/support.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/tickets", ctrl.createTicket);
router.get("/tickets", ctrl.listMyTickets);
router.get("/tickets/all", requireRole("ADMIN"), ctrl.listAllTickets);
router.get("/tickets/:id", ctrl.getTicket);
router.patch("/tickets/:id", requireRole("ADMIN"), ctrl.updateTicketStatus);

module.exports = router;
