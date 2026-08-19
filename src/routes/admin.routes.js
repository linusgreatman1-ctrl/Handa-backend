const express = require("express");
const { requireAuth, requireRole, requireSuperAdmin } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");
const adminMgmt = require("../controllers/adminManagement.controller");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/dashboard", ctrl.dashboardStats);
// Analytics — super-admin only.
router.get("/reports", requireSuperAdmin, ctrl.getReports);

router.get("/users", ctrl.listUsers);
router.patch("/users/:id/status", ctrl.updateUserStatus);

router.get("/vendors", ctrl.listVendorsForAdmin);
router.patch("/vendors/:id/verify", ctrl.setVendorVerified);
router.patch("/riders/:id/verify", ctrl.setRiderVerified);
router.patch("/shoppers/:id/verify", ctrl.setShopperVerified);

router.get("/kyc-documents", ctrl.listKycDocumentsForAdmin);
router.patch("/kyc-documents/:id", ctrl.reviewKycDocument);

router.get("/withdrawals", ctrl.listWithdrawalsForAdmin);

// Rider-session monitoring — super-admin only.
router.get("/shop-sessions", requireSuperAdmin, ctrl.listShopSessionsForAdmin);
router.get("/shop-sessions/:id", requireSuperAdmin, ctrl.getShopSessionTimeline);

// Handover code lookup (support-desk use) — super-admin only.
router.get("/active-codes", requireSuperAdmin, ctrl.lookupActiveCodes);

// Admin management + audit trail — super-admin only.
router.get("/admins", requireSuperAdmin, adminMgmt.listAdmins);
router.post("/admins", requireSuperAdmin, adminMgmt.createAdmin);
router.patch("/admins/:id/suspend", requireSuperAdmin, adminMgmt.suspendAdmin);
router.patch("/admins/:id/reactivate", requireSuperAdmin, adminMgmt.reactivateAdmin);
router.patch("/admins/:id/remove", requireSuperAdmin, adminMgmt.removeAdmin);
router.get("/audit-log", requireSuperAdmin, adminMgmt.listAuditLog);

module.exports = router;
