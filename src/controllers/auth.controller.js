const crypto = require("crypto");
const prisma = require("../config/db");
const { hashPassword, comparePassword, isStrongPassword } = require("../utils/password");
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require("../utils/jwt");

const REFRESH_COOKIE_NAME = "handa_refresh";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function issueSession(res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  // Also returned in the JSON body (not just the cookie) so the frontend can
  // store it per-tab (sessionStorage) instead of relying solely on the
  // cookie, which is domain-scoped and shared across every tab of the same
  // browser -- with only the cookie, two tabs logged into two different
  // accounts collide on refresh (whichever tab refreshes second silently
  // adopts -- or, with last session's sub-mismatch guard, gets force-logged-
  // out by -- the OTHER tab's account). Each RefreshToken DB row already
  // rotates independently by its own token hash, so handing the raw value
  // back per-response is all that's needed for genuinely independent
  // per-tab sessions; the cookie stays as a fallback for any caller that
  // doesn't use the body-token path.
  return { accessToken, refreshToken };
}

// Every account gets a Wallet + default NotificationPreference regardless
// of role — customers hold escrow refunds/change there too, not just
// payable roles.
function baseCreateData({ name, email, phone, passwordHash, role, address, state, lga, bankName, bankAccountNumber, bankAccountName, isGuest }) {
  return {
    name,
    email: email || null,
    phone: phone || null,
    passwordHash: passwordHash || null,
    isGuest: !!isGuest,
    role,
    address: address || null,
    state: state || null,
    lga: lga || null,
    bankName: bankName || null,
    bankAccountNumber: bankAccountNumber || null,
    bankAccountName: bankAccountName || null,
    wallet: { create: {} },
    notificationPref: { create: {} },
  };
}

async function register(req, res, next) {
  try {
    const {
      name,
      email,
      phone,
      password,
      role = "CUSTOMER",
      address,
      state,
      lga,
      bankName,
      bankAccountNumber,
      bankAccountName,
      // VENDOR-only
      vtype,
      bizName,
      description,
      tags,
      // RIDER-only
      vehicleType,
      plateNumber,
      // SHOPPER-only
      market,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!email && !phone) {
      return res.status(400).json({ error: "Email or phone is required." });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!["CUSTOMER", "VENDOR", "RIDER", "SHOPPER"].includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    if (role === "VENDOR") {
      if (!vtype || !["HOME_COOK", "EVENT_PLANNER"].includes(vtype)) {
        return res.status(400).json({ error: "A valid vendor type (vtype) is required." });
      }
      if (!bizName || !bizName.trim()) {
        return res.status(400).json({ error: "Business name is required for vendor accounts." });
      }
    }

    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(409).json({ error: "An account with this email already exists." });
    }
    if (phone) {
      const existing = await prisma.user.findUnique({ where: { phone } });
      if (existing) return res.status(409).json({ error: "An account with this phone number already exists." });
    }

    const passwordHash = await hashPassword(password);

    const data = baseCreateData({ name, email, phone, passwordHash, role, address, state, lga, bankName, bankAccountNumber, bankAccountName });

    if (role === "VENDOR") {
      data.vendorProfile = {
        create: {
          vtype,
          bizName,
          description: description || null,
          tags: Array.isArray(tags) ? tags : [],
        },
      };
    } else if (role === "RIDER") {
      data.riderProfile = { create: { vehicleType: vehicleType || null, plateNumber: plateNumber || null } };
    } else if (role === "SHOPPER") {
      data.shopperProfile = { create: { market: market || null } };
    }

    const user = await prisma.user.create({
      data,
      include: { vendorProfile: true, riderProfile: true, shopperProfile: true, wallet: true },
    });

    const { accessToken, refreshToken } = await issueSession(res, user);
    res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, phone, password } = req.body;
    if ((!email && !phone) || !password) {
      return res.status(400).json({ error: "Email/phone and password are required." });
    }

    const user = await prisma.user.findFirst({
      where: email ? { email } : { phone },
      include: { vendorProfile: true, riderProfile: true, shopperProfile: true, wallet: true },
    });

    if (!user || !user.passwordHash || !(await comparePassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ error: "This account is not active." });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const { accessToken, refreshToken } = await issueSession(res, user);
    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

// Lets a shopper browse/checkout without registering, matching the
// frontend's "Continue as Guest" button. Guest accounts are CUSTOMER-role,
// have no password, and can be upgraded later via a normal register call
// once they add an email/phone (not implemented here — out of scope until
// the frontend actually offers "save my guest cart to an account").
async function guestLogin(req, res, next) {
  try {
    const guestTag = crypto.randomBytes(4).toString("hex");
    const user = await prisma.user.create({
      data: {
        name: "Guest",
        isGuest: true,
        role: "CUSTOMER",
        wallet: { create: {} },
        notificationPref: { create: {} },
      },
    });
    const { accessToken, refreshToken } = await issueSession(res, user);
    res.status(201).json({ user: publicUser(user), accessToken, refreshToken, guestTag });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    // Prefer a body-supplied token (this tab's own, from sessionStorage)
    // over the shared cookie -- the cookie is domain-scoped and collides
    // across every tab of the same browser, which is exactly what let one
    // tab's login silently invalidate (or, with the sub-mismatch guard,
    // force-logout) a completely unrelated tab logged into a different
    // account. Still falls back to the cookie for any caller that never
    // adopted the body-token path.
    const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) return res.status(401).json({ error: "No refresh token." });

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired refresh token." });
    }

    const tokenHash = hashToken(token);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: "Invalid or expired refresh token." });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { vendorProfile: true, riderProfile: true, shopperProfile: true },
    });
    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ error: "Account is not active." });
    }

    // Rotate: revoke the used refresh token, issue a fresh pair.
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });
    const { accessToken, refreshToken } = await issueSession(res, user);
    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    // Same body-first fallback as refresh() -- revokes THIS tab's own
    // token, not whichever one the shared cookie currently happens to hold.
    const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE_NAME];
    if (token) {
      await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token) }, data: { revoked: true } });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        vendorProfile: true,
        riderProfile: true,
        shopperProfile: true,
        wallet: true,
        notificationPref: true,
        addresses: true,
      },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, guestLogin, refresh, logout, me };
