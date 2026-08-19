const express = require("express");

const router = express.Router();

// Public — ICE server info (including TURN credentials, if configured) is
// meant to be handed to WebRTC clients directly. Letting this live in env
// vars means a TURN server can be added later without a frontend redeploy.
router.get("/ice-servers", (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

module.exports = router;
