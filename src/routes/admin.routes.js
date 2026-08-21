const express = require("express");
const { requireAuth, requireRole, requireSuperAdmin, requireContentOrSuperAdmin } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");
const adminMgmt = require("../controllers/adminManagement.controller");
const adminFiles = require("../controllers/adminFiles.controller");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/dashboard", ctrl.dashboardStats);
// Analytics — content admin or super admin.
router.get("/reports", requireContentOrSuperAdmin, ctrl.getReports);

router.get("/users", ctrl.listUsers);
router.get("/users/:id", requireContentOrSuperAdmin, ctrl.getCustomerDetailForAdmin);
router.patch("/users/:id/status", ctrl.updateUserStatus);

router.get("/vendors", ctrl.listVendorsForAdmin);
router.get("/vendors/:id", requireContentOrSuperAdmin, ctrl.getVendorDetailForAdmin);
router.patch("/vendors/:id/verify", ctrl.setVendorVerified);
router.delete("/menu-items/:id", requireSuperAdmin, ctrl.deleteMenuItemForAdmin);
router.delete("/service-packages/:id", requireSuperAdmin, ctrl.deleteServicePackageForAdmin);
router.post("/users/:id/sms", requireContentOrSuperAdmin, ctrl.smsUserForAdmin);
router.post("/users/:id/call", requireContentOrSuperAdmin, ctrl.callUserForAdmin);
router.get("/riders", requireContentOrSuperAdmin, ctrl.listRidersForAdmin);
router.get("/riders/:id", requireContentOrSuperAdmin, ctrl.getRiderDetailForAdmin);
router.patch("/riders/:id/verify", ctrl.setRiderVerified);
router.get("/shoppers", requireContentOrSuperAdmin, ctrl.listShoppersForAdmin);
router.get("/shoppers/:id", requireContentOrSuperAdmin, ctrl.getShopperDetailForAdmin);
router.patch("/shoppers/:id/verify", ctrl.setShopperVerified);

router.get("/kyc-documents", ctrl.listKycDocumentsForAdmin);
router.patch("/kyc-documents/:id", ctrl.reviewKycDocument);

router.get("/withdrawals", ctrl.listWithdrawalsForAdmin);
router.get("/payments", requireContentOrSuperAdmin, ctrl.listPayments);

router.get("/bookings", requireContentOrSuperAdmin, ctrl.listBookingsForAdmin);
router.get("/bookings/:id", requireContentOrSuperAdmin, ctrl.getBookingDetailForAdmin);
router.get("/commissions", requireContentOrSuperAdmin, ctrl.listCommissionsForAdmin);
router.get("/escrow", requireContentOrSuperAdmin, ctrl.listEscrowHoldsForAdmin);
router.get("/ratings", requireContentOrSuperAdmin, ctrl.listRatingsForAdmin);

// Rider-session monitoring — content admin or super admin.
router.get("/shop-sessions", requireContentOrSuperAdmin, ctrl.listShopSessionsForAdmin);
router.get("/shop-sessions/:id", requireContentOrSuperAdmin, ctrl.getShopSessionTimeline);

// Handover code lookup (support-desk use) — content admin or super admin.
router.get("/active-codes", requireContentOrSuperAdmin, ctrl.lookupActiveCodes);

// Vendor "featured listing" boosts — Handa's real subscription-like
// concept. Viewing is content-admin-or-super; manually extending one
// (overriding billing) is super-admin only.
router.get("/subscriptions", requireContentOrSuperAdmin, ctrl.listSubscriptionsForAdmin);
router.patch("/subscriptions/:id", requireSuperAdmin, ctrl.extendSubscription);

// Generic config store — viewing is content-admin-or-super; writing is
// super-admin only.
router.get("/app-settings", requireContentOrSuperAdmin, ctrl.listAppSettings);
router.put("/app-settings/:key", requireSuperAdmin, ctrl.upsertAppSetting);
router.delete("/app-settings/:key", requireSuperAdmin, ctrl.deleteAppSetting);

// Platform-wide announcements — viewing the sent history is content-admin-
// or-super; sending a new one is super-admin only.
router.get("/announcements", requireContentOrSuperAdmin, ctrl.listAnnouncements);
router.post("/announcements", requireSuperAdmin, ctrl.sendAnnouncement);

// AI Meal Planner conversation log — content admin or super admin. Empty
// until a real AI provider is wired up (see AiConversationLog comment).
router.get("/ai-conversations", requireContentOrSuperAdmin, ctrl.listAiConversations);

// Admin management + audit trail — super-admin only.
router.get("/admins", requireSuperAdmin, adminMgmt.listAdmins);
router.post("/admins", requireSuperAdmin, adminMgmt.createAdmin);
router.patch("/admins/:id/suspend", requireSuperAdmin, adminMgmt.suspendAdmin);
router.patch("/admins/:id/reactivate", requireSuperAdmin, adminMgmt.reactivateAdmin);
router.patch("/admins/:id/remove", requireSuperAdmin, adminMgmt.removeAdmin);
router.get("/audit-log", requireSuperAdmin, adminMgmt.listAuditLog);

// Code Editor (targeted find/replace) + Codes (full raw-file editor) —
// live-patch public/app/index.html and public/admin/index.html. Viewing
// (list/search/backups/content) is content-admin-or-super; every write
// (replace/restore/save) is super-admin only — a content admin can look
// but never touch the live files, mirroring PassNow's CONTENT_ADMIN split.
router.get("/files", requireContentOrSuperAdmin, adminFiles.listFiles);
router.post("/files/search", requireContentOrSuperAdmin, adminFiles.searchInFile);
router.post("/files/replace", requireSuperAdmin, adminFiles.replaceInFile);
router.get("/files/backups", requireContentOrSuperAdmin, adminFiles.listBackups);
router.post("/files/restore", requireSuperAdmin, adminFiles.restoreBackup);
router.get("/files/content", requireContentOrSuperAdmin, adminFiles.getContent);
router.post("/files/save", requireSuperAdmin, express.text({ type: "*/*", limit: "5mb" }), adminFiles.saveContent);

module.exports = router;
