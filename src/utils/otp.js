const crypto = require("crypto");

// Short numeric handover codes — not a security secret, just a lightweight
// "were you actually handed the items" proof between two people standing
// in front of each other, matching the architecture doc's own example
// ("Handover Code: 8492").
function generateOtpCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

module.exports = { generateOtpCode };
