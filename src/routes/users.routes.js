const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/users.controller");

const router = express.Router();

router.use(requireAuth);

router.patch("/me", ctrl.updateProfile);
router.patch("/me/vendor-profile", ctrl.updateVendorProfile);
router.patch("/me/rider-profile", ctrl.updateRiderProfile);
router.patch("/me/shopper-profile", ctrl.updateShopperProfile);
router.post("/me/vendor-profile", ctrl.createVendorProfile);
router.post("/me/rider-profile", ctrl.createRiderProfile);
router.post("/me/shopper-profile", ctrl.createShopperProfile);
router.patch("/me/availability", ctrl.setAvailability);
router.post("/me/avatar", upload.single("avatar"), ctrl.uploadAvatar);

router.get("/banks", ctrl.listBanks);
router.post("/me/bank-account", ctrl.linkBankAccount);

router.get("/me/addresses", ctrl.listAddresses);
router.post("/me/addresses", ctrl.createAddress);
router.delete("/me/addresses/:id", ctrl.deleteAddress);

router.get("/me/notification-preferences", ctrl.getNotificationPreferences);
router.patch("/me/notification-preferences", ctrl.updateNotificationPreferences);

module.exports = router;
