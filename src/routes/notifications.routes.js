const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/notifications.controller");

const router = express.Router();
router.use(requireAuth);

router.get("/", ctrl.listNotifications);
router.patch("/:id/read", ctrl.markRead);
router.patch("/read-all", ctrl.markAllRead);

module.exports = router;
