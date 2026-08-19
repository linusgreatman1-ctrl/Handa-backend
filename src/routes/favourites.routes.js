const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/favourites.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/", ctrl.addFavourite);
router.get("/", ctrl.listFavourites);
router.delete("/:targetType/:targetId", ctrl.removeFavourite);

module.exports = router;
