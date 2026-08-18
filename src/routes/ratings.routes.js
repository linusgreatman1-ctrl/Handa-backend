const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/ratings.controller");

const router = express.Router();

router.get("/user/:userId", ctrl.listRatingsForUser);
router.post("/", requireAuth, ctrl.createRating);

module.exports = router;
