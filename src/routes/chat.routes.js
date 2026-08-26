const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/chat.controller");

const router = express.Router();
router.use(requireAuth);

router.post("/threads", ctrl.openThread);
router.post("/support-thread", ctrl.openSupportThread);
router.get("/threads", ctrl.listThreads);
router.get("/threads/:id/messages", ctrl.listMessages);
router.post("/threads/:id/messages", ctrl.sendMessage);
router.post("/threads/:id/close", ctrl.closeThread);
router.post("/threads/:id/attachment", upload.single("file"), ctrl.uploadChatAttachment);

module.exports = router;
