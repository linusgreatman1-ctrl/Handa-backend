const crypto = require("crypto");

// Short human-readable reference codes for orders/bookings/withdrawals,
// e.g. "HND-FD-7K2Q9A". Not a security token — uniqueness is enforced by
// the DB's @unique constraint, this just keeps retries cheap.
function generateReference(prefix) {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `HND-${prefix}-${rand}`;
}

module.exports = { generateReference };
