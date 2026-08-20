const express = require("express");
const ctrl = require("../controllers/voice.controller");

const router = express.Router();

// Unauthenticated by design — this is Africa's Talking's own server
// calling back into us mid-call, not a browser/app request. It carries no
// sensitive data (just "what do I do with this call"), so the only real
// risk of leaving it open is someone spamming it to see the same fixed
// XML response, which reveals nothing.
router.post("/callback", ctrl.handleVoiceCallback);

module.exports = router;
