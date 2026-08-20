// Africa's Talking hits this webhook once an outbound call we initiated
// (via africastalking.service.js's initiateCall) is answered. We respond
// with their Voice XML telling it what to do next — here, always bridge
// the call to AFRICASTALKING_SUPPORT_NUMBER so an admin's "Call" action
// results in a real two-way conversation, not just a ring.
async function handleVoiceCallback(req, res, next) {
  try {
    const supportNumber = process.env.AFRICASTALKING_SUPPORT_NUMBER;
    res.set("Content-Type", "application/xml");
    if (!supportNumber) {
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman">Sorry, no support line is configured right now.</Say></Response>`);
    }
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial phoneNumbers="${supportNumber}"/></Response>`);
  } catch (err) {
    next(err);
  }
}

module.exports = { handleVoiceCallback };
