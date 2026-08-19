const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/kyc.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/documents", upload.single("document"), ctrl.uploadKycDocument);
router.get("/documents", ctrl.listMyKycDocuments);

module.exports = router;
