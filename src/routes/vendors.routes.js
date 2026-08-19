const express = require("express");
const { requireAuth, requireVendorProfile } = require("../middleware/auth");
const ctrl = require("../controllers/vendors.controller");

const router = express.Router();

router.get("/", ctrl.listVendors);
router.get("/me", requireAuth, requireVendorProfile, ctrl.getMyVendor);
router.get("/me/commission-period", requireAuth, requireVendorProfile, ctrl.getCurrentCommissionPeriod);
router.get("/:id", ctrl.getVendor);
router.get("/:id/menu", ctrl.listMenuItems);

router.use(requireAuth, requireVendorProfile);
router.post("/me/menu", ctrl.createMenuItem);
router.put("/me/menu/:itemId", ctrl.updateMenuItem);
router.delete("/me/menu/:itemId", ctrl.deleteMenuItem);

router.post("/me/packages", ctrl.createServicePackage);
router.put("/me/packages/:pkgId", ctrl.updateServicePackage);
router.delete("/me/packages/:pkgId", ctrl.deleteServicePackage);

module.exports = router;
