const prisma = require("../config/db");
const paystack = require("../services/paystack.service");

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function updateProfile(req, res, next) {
  try {
    const { name, phone, email, address, state, lga, lat, lng } = req.body;

    if (phone !== undefined && phone) {
      const existing = await prisma.user.findUnique({ where: { phone } });
      if (existing && existing.id !== req.user.id) return res.status(409).json({ error: "This phone number is already linked to another account." });
    }
    if (email !== undefined && email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== req.user.id) return res.status(409).json({ error: "This email is already linked to another account." });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone: phone || null }),
        ...(email !== undefined && { email: email || null }),
        ...(address !== undefined && { address }),
        ...(state !== undefined && { state }),
        ...(lga !== undefined && { lga }),
        ...(lat !== undefined && { lat }),
        ...(lng !== undefined && { lng }),
      },
      include: { vendorProfile: true, riderProfile: true, shopperProfile: true, wallet: true },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

// Vendor-only fields (bizName, vtype-specific tags, rates) live on
// VendorProfile — separate from the shared User profile above.
async function updateVendorProfile(req, res, next) {
  try {
    if (!req.user.vendorProfile) return res.status(403).json({ error: "No vendor profile found." });
    const { bizName, description, bio, emoji, bannerColor, tags, languages, minOrderKobo, baseDeliveryFeeKobo, prepTimeMinutes, hourlyRateKobo, ratePeriod } = req.body;
    const profile = await prisma.vendorProfile.update({
      where: { id: req.user.vendorProfile.id },
      data: {
        ...(bizName !== undefined && { bizName }),
        ...(description !== undefined && { description }),
        ...(bio !== undefined && { bio }),
        ...(emoji !== undefined && { emoji }),
        ...(bannerColor !== undefined && { bannerColor }),
        ...(tags !== undefined && { tags }),
        ...(languages !== undefined && { languages }),
        ...(minOrderKobo !== undefined && { minOrderKobo }),
        ...(baseDeliveryFeeKobo !== undefined && { baseDeliveryFeeKobo }),
        ...(prepTimeMinutes !== undefined && { prepTimeMinutes }),
        ...(hourlyRateKobo !== undefined && { hourlyRateKobo }),
        ...(ratePeriod !== undefined && { ratePeriod }),
      },
    });
    res.json({ vendorProfile: profile });
  } catch (err) {
    next(err);
  }
}

async function updateRiderProfile(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
    const { vehicleType, plateNumber } = req.body;
    const profile = await prisma.riderProfile.update({
      where: { id: req.user.riderProfile.id },
      data: {
        ...(vehicleType !== undefined && { vehicleType }),
        ...(plateNumber !== undefined && { plateNumber }),
      },
    });
    res.json({ riderProfile: profile });
  } catch (err) {
    next(err);
  }
}

async function updateShopperProfile(req, res, next) {
  try {
    if (!req.user.shopperProfile) return res.status(403).json({ error: "No shopper profile found." });
    const { market, specialties } = req.body;
    const profile = await prisma.shopperProfile.update({
      where: { id: req.user.shopperProfile.id },
      data: {
        ...(market !== undefined && { market }),
        ...(specialties !== undefined && { specialties }),
      },
    });
    res.json({ shopperProfile: profile });
  } catch (err) {
    next(err);
  }
}

// ── Add-a-role endpoints — intentionally disabled ────────────────────
// Each role (customer, rider, shopper, home cook, event planner) requires
// its own registered account with its own login credentials — one login
// must never unlock more than one account's dashboards. These three routes
// stay mounted (so an old client hitting them gets a clear message instead
// of a 404) but always refuse.
function multiRoleDisabled(req, res) {
  res.status(403).json({ error: "Adding another role to an existing account isn't supported. Please register a separate account for this role." });
}
async function createVendorProfile(req, res) {
  multiRoleDisabled(req, res);
}
async function createRiderProfile(req, res) {
  multiRoleDisabled(req, res);
}
async function createShopperProfile(req, res) {
  multiRoleDisabled(req, res);
}

// "Go Online" toggle — drives whether a vendor/rider/shopper receives new
// order/session broadcasts (see realtime/live.js presence rooms). Accepts
// an explicit `profile` so a multi-role account (e.g. rider AND shopper)
// can toggle a capacity other than their primary registered role; falls
// back to the role-derived profile when omitted, matching pre-multi-role
// callers.
async function setAvailability(req, res, next) {
  try {
    const { isOnline, profile } = req.body;
    if (typeof isOnline !== "boolean") return res.status(400).json({ error: "isOnline (boolean) is required." });

    const target = profile || { VENDOR: "vendor", RIDER: "rider", SHOPPER: "shopper" }[req.user.role];
    const targetProfile = { vendor: req.user.vendorProfile, rider: req.user.riderProfile, shopper: req.user.shopperProfile }[target];
    if (!targetProfile) return res.status(400).json({ error: "This account has no matching profile to toggle." });

    // Going offline is always allowed; going live requires admin-reviewed
    // KYC documents to have earned this profile a verified flag first.
    if (isOnline && !targetProfile.isVerified) {
      return res.status(403).json({ error: "Your account is pending verification. Submit your documents and wait for admin approval before going online." });
    }

    let updated;
    if (target === "vendor") {
      updated = await prisma.vendorProfile.update({ where: { id: targetProfile.id }, data: { isOnline } });
    } else if (target === "rider") {
      updated = await prisma.riderProfile.update({ where: { id: targetProfile.id }, data: { isOnline } });
    } else if (target === "shopper") {
      updated = await prisma.shopperProfile.update({ where: { id: targetProfile.id }, data: { isOnline } });
    }

    req.app.get("io")?.emit("presence:update", { userId: req.user.id, role: target, isOnline });
    res.json({ isOnline });
  } catch (err) {
    next(err);
  }
}

// Powers the customer profile header's "Orders"/"Reviews" stat pills —
// previously hardcoded (47/12) regardless of the logged-in account.
async function getMyStats(req, res, next) {
  try {
    const [completedBookings, completedSessions, reviewsGiven] = await Promise.all([
      prisma.booking.count({ where: { customerId: req.user.id, status: "COMPLETED" } }),
      prisma.shopSession.count({ where: { customerId: req.user.id, status: "COMPLETED" } }),
      prisma.rating.count({ where: { raterId: req.user.id } }),
    ]);
    res.json({ ordersCount: completedBookings + completedSessions, reviewsCount: reviewsGiven });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const avatarUrl = `/uploads/${req.file.filename}`;
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl } });
    res.json({ avatarUrl: user.avatarUrl });
  } catch (err) {
    next(err);
  }
}

// Resolves a NUBAN account number to its holder name via Paystack, then
// links it as this user's payout account — this is what the frontend's
// "Confirm Withdrawal" / bank-details modals actually need behind them
// (previously a hardcoded "GTBank • 0123456789" string on the client).
async function linkBankAccount(req, res, next) {
  try {
    const { bankName, bankCode, accountNumber, accountName } = req.body;
    if (!bankName || !bankCode || !accountNumber) {
      return res.status(400).json({ error: "bankName, bankCode, and accountNumber are required." });
    }
    // A real bank-registered account name often differs from the person's
    // display/business name -- Paystack's auto-resolution is still tried
    // first (the most reliable source when it works), but a client-
    // supplied name is now a real fallback/override instead of the whole
    // request failing outright whenever resolution errors (no key
    // configured, an unrecognized bank, a transient API issue).
    let resolvedName = accountName ? String(accountName).trim() : "";
    try {
      const resolved = await paystack.resolveBankAccount(accountNumber, bankCode);
      resolvedName = resolved.account_name;
    } catch (err) {
      if (!resolvedName) throw err;
    }
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { bankName, bankAccountNumber: accountNumber, bankAccountName: resolvedName },
    });
    res.json({ bankName: user.bankName, bankAccountNumber: user.bankAccountNumber, bankAccountName: user.bankAccountName });
  } catch (err) {
    next(err);
  }
}

async function listBanks(req, res, next) {
  try {
    const banks = await paystack.listBanks();
    res.json({ banks });
  } catch (err) {
    next(err);
  }
}

async function listAddresses(req, res, next) {
  try {
    const addresses = await prisma.address.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ addresses });
  } catch (err) {
    next(err);
  }
}

async function createAddress(req, res, next) {
  try {
    const { label, line, state, lga, lat, lng, isDefault } = req.body;
    if (!label || !line) return res.status(400).json({ error: "label and line are required." });
    if (isDefault) {
      await prisma.address.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
    }
    const address = await prisma.address.create({
      data: { userId: req.user.id, label, line, state, lga, lat, lng, isDefault: !!isDefault },
    });
    res.status(201).json({ address });
  } catch (err) {
    next(err);
  }
}

async function deleteAddress(req, res, next) {
  try {
    const address = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!address || address.userId !== req.user.id) return res.status(404).json({ error: "Address not found." });
    await prisma.address.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getNotificationPreferences(req, res, next) {
  try {
    const pref = await prisma.notificationPreference.upsert({
      where: { userId: req.user.id },
      update: {},
      create: { userId: req.user.id },
    });
    res.json({ preferences: pref });
  } catch (err) {
    next(err);
  }
}

async function updateNotificationPreferences(req, res, next) {
  try {
    const { orderUpdates, promotions, riderAlerts, newFeatures } = req.body;
    const pref = await prisma.notificationPreference.upsert({
      where: { userId: req.user.id },
      update: {
        ...(orderUpdates !== undefined && { orderUpdates }),
        ...(promotions !== undefined && { promotions }),
        ...(riderAlerts !== undefined && { riderAlerts }),
        ...(newFeatures !== undefined && { newFeatures }),
      },
      create: { userId: req.user.id, orderUpdates, promotions, riderAlerts, newFeatures },
    });
    res.json({ preferences: pref });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  updateProfile,
  updateVendorProfile,
  updateRiderProfile,
  updateShopperProfile,
  createVendorProfile,
  createRiderProfile,
  createShopperProfile,
  setAvailability,
  getMyStats,
  uploadAvatar,
  linkBankAccount,
  listBanks,
  listAddresses,
  createAddress,
  deleteAddress,
  getNotificationPreferences,
  updateNotificationPreferences,
};
