const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/dashboard", ctrl.dashboardStats);
router.get("/reports", ctrl.getReports);

router.get("/users", ctrl.listUsers);
router.patch("/users/:id/status", ctrl.updateUserStatus);

router.get("/vendors", ctrl.listVendorsForAdmin);
router.patch("/vendors/:id/verify", ctrl.setVendorVerified);
router.patch("/riders/:id/verify", ctrl.setRiderVerified);
router.patch("/shoppers/:id/verify", ctrl.setShopperVerified);

router.get("/kyc-documents", ctrl.listKycDocumentsForAdmin);
router.patch("/kyc-documents/:id", ctrl.reviewKycDocument);

router.get("/withdrawals", ctrl.listWithdrawalsForAdmin);

router.get("/shop-sessions", ctrl.listShopSessionsForAdmin);
router.get("/shop-sessions/:id", ctrl.getShopSessionTimeline);

module.exports = router;
