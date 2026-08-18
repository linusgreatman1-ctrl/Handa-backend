const { verifyAccessToken } = require("../utils/jwt");
const prisma = require("../config/db");

// Verifies the Bearer access token, loads a fresh minimal user record (so a
// suspended account is rejected even with a still-valid token) plus the
// role-specific profile id each controller needs, and attaches it to
// req.user.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Authentication required." });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        status: true,
        name: true,
        email: true,
        phone: true,
        vendorProfile: { select: { id: true, vtype: true } },
        riderProfile: { select: { id: true } },
        shopperProfile: { select: { id: true } },
      },
    });

    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ error: "Account is not active." });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Restricts a route to one or more roles, e.g. requireRole('VENDOR', 'ADMIN').
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action." });
    }
    next();
  };
}

// A VENDOR-role user without a vendorProfile hasn't finished onboarding
// (shouldn't happen post-registration, but guards controllers that assume
// req.user.vendorProfile.id exists).
function requireVendorProfile(req, res, next) {
  if (!req.user.vendorProfile) {
    return res.status(403).json({ error: "No vendor profile found for this account." });
  }
  next();
}

function requireRiderProfile(req, res, next) {
  if (!req.user.riderProfile) {
    return res.status(403).json({ error: "No rider profile found for this account." });
  }
  next();
}

function requireShopperProfile(req, res, next) {
  if (!req.user.shopperProfile) {
    return res.status(403).json({ error: "No shopper profile found for this account." });
  }
  next();
}

module.exports = {
  requireAuth,
  requireRole,
  requireVendorProfile,
  requireRiderProfile,
  requireShopperProfile,
};
