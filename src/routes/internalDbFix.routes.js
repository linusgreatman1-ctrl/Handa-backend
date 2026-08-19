// TEMPORARY: a one-time HTTP-triggered diagnostic, used only because this
// host (Render free tier) blocks external DB connections and the deploy
// migration failed partway through, leaving Postgres in a state Prisma
// refuses to touch further until resolved. Same gating pattern as
// internalSeed.routes.js. Read-only — inspects state, changes nothing.
// Delete this file (and its mount in server.js) once the migration issue
// is resolved.
const express = require("express");
const prisma = require("../config/db");

const router = express.Router();

router.get("/", async (req, res) => {
  if (!process.env.SEED_SECRET || req.query.key !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const migrations = await prisma.$queryRawUnsafe(
      `SELECT id, migration_name, started_at, finished_at, applied_steps_count, rolled_back_at, logs
       FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5`
    );
    const vendorTypeEnum = await prisma.$queryRawUnsafe(
      `SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'VendorType')`
    );
    const orderTableExists = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Order') AS exists`
    );
    const orderItemTableExists = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'OrderItem') AS exists`
    );
    const ratingOrderIdCol = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Rating' AND column_name = 'orderId') AS exists`
    );
    const escrowOrderIdCol = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EscrowHold' AND column_name = 'orderId') AS exists`
    );
    const vendorTypeCounts = await prisma.$queryRawUnsafe(
      `SELECT vtype, COUNT(*)::int AS count FROM "VendorProfile" GROUP BY vtype`
    );
    res.json(
      JSON.parse(
        JSON.stringify(
          { migrations, vendorTypeEnum, orderTableExists, orderItemTableExists, ratingOrderIdCol, escrowOrderIdCol, vendorTypeCounts },
          (key, value) => (typeof value === "bigint" ? value.toString() : value)
        )
      )
    );
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
