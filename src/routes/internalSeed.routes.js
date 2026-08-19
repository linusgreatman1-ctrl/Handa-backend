// TEMPORARY: a one-time HTTP-triggered seed, used only because this host
// (Render free tier) blocks both external DB connections and one-off Job
// runs, so the CLI seed script can't be run from outside the deployed
// process itself. Gated by SEED_SECRET so it isn't a public write
// endpoint. Delete this file (and its mount in server.js) once the
// database has real data and this is no longer needed.
const express = require("express");
const seedMain = require("../../prisma/seed");

const router = express.Router();

router.get("/", async (req, res) => {
  if (!process.env.SEED_SECRET || req.query.key !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await seedMain();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
