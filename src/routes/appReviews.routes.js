const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/appReviews.controller");

const router = express.Router();

router.get("/", ctrl.listPublicReviews);
router.get("/mine", requireAuth, ctrl.getMyReview);
router.post("/", requireAuth, ctrl.createOrUpdateMyReview);

module.exports = router;
