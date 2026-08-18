const express = require("express");
const { body } = require("express-validator");
const rateLimit = require("express-rate-limit");
const { validate } = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/auth.controller");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

router.post(
  "/register",
  authLimiter,
  [
    body("name").trim().isLength({ min: 2 }).withMessage("Name is required."),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters."),
    body("email").optional().isEmail().withMessage("A valid email is required."),
    body("phone").optional().isString().isLength({ min: 10 }).withMessage("A valid phone number is required."),
    body("role").optional().isIn(["CUSTOMER", "VENDOR", "RIDER", "SHOPPER"]),
  ],
  validate,
  ctrl.register
);

router.post(
  "/login",
  authLimiter,
  [
    body("email").optional().isEmail(),
    body("phone").optional().isString(),
    body("password").notEmpty().withMessage("Password is required."),
  ],
  validate,
  ctrl.login
);

router.post("/guest", authLimiter, ctrl.guestLogin);
router.post("/refresh", ctrl.refresh);
router.post("/logout", ctrl.logout);
router.get("/me", requireAuth, ctrl.me);

module.exports = router;
