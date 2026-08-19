const express = require("express");
const { requireAuth, requireShopperProfile } = require("../middleware/auth");
const ctrl = require("../controllers/shoppers.controller");

const router = express.Router();

router.get("/", ctrl.listShoppers);
router.get("/:id", ctrl.getShopper);

router.use(requireAuth, requireShopperProfile);
router.get("/me/sellers", ctrl.listSellers);
router.post("/me/sellers", ctrl.createSeller);
router.delete("/me/sellers/:id", ctrl.deleteSeller);

module.exports = router;
