const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/dashboard", ctrl.dashboardStats);

router.get("/users", ctrl.listUsers);
router.patch("/users/:id/status", ctrl.updateUserStatus);

router.get("/vendors", ctrl.listVendorsForAdmin);
router.patch("/vendors/:id/verify", ctrl.setVendorVerified);

router.get("/withdrawals", ctrl.listWithdrawalsForAdmin);

module.exports = router;
