const prisma = require("../config/db");
const paystack = require("../services/paystack.service");

async function listShoppers(req, res, next) {
  try {
    const { market, online } = req.query;
    const shoppers = await prisma.shopperProfile.findMany({
      where: {
        ...(market && { market }),
        ...(online === "true" && { isOnline: true }),
      },
      include: { user: { select: { name: true, avatarUrl: true } } },
      orderBy: { ratingAvg: "desc" },
    });
    res.json({ shoppers });
  } catch (err) {
    next(err);
  }
}

async function getShopper(req, res, next) {
  try {
    const shopper = await prisma.shopperProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { name: true, avatarUrl: true, phone: true } } },
    });
    if (!shopper) return res.status(404).json({ error: "Shopper not found." });
    res.json({ shopper });
  } catch (err) {
    next(err);
  }
}

// ── Registered market sellers (the shopper's own contact book of stall
// owners they buy from, paid directly out of session escrow) ──

async function listSellers(req, res, next) {
  try {
    const sellers = await prisma.registeredSeller.findMany({ where: { shopperId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ sellers });
  } catch (err) {
    next(err);
  }
}

async function createSeller(req, res, next) {
  try {
    const { name, phone, market, bankName, bankCode, accountNumber, accountName } = req.body;
    if (!name || !phone || !bankName || !bankCode || !accountNumber) {
      return res.status(400).json({ error: "name, phone, bankName, bankCode, and accountNumber are required." });
    }
    // Paystack auto-resolves the real account-holder name when a real
    // bankCode + PAYSTACK_SECRET_KEY are both available -- but the seller
    // form now also allows a custom/unlisted bank (bankCode "CUSTOM") and
    // must keep working even with no Paystack key configured at all, so a
    // failed/unavailable resolution falls back to whatever account name
    // the shopper typed in themselves instead of hard-failing the whole
    // registration. A real Paystack-initiated transfer to an unresolved
    // custom bank still isn't possible without a real key regardless --
    // this only unblocks the form/registration, not real money movement.
    let resolvedName = accountName ? String(accountName).trim() : "";
    if (bankCode !== "CUSTOM") {
      try {
        const resolved = await paystack.resolveBankAccount(accountNumber, bankCode);
        resolvedName = resolved.account_name;
      } catch (err) {
        if (!resolvedName) resolvedName = "Not verified — confirm with the seller before paying";
      }
    } else if (!resolvedName) {
      resolvedName = "Not verified — confirm with the seller before paying";
    }
    const seller = await prisma.registeredSeller.create({
      data: {
        shopperId: req.user.id,
        name,
        phone,
        market,
        bankName,
        bankCode,
        bankAccountNumber: accountNumber,
        bankAccountName: resolvedName,
      },
    });
    res.status(201).json({ seller });
  } catch (err) {
    next(err);
  }
}

async function deleteSeller(req, res, next) {
  try {
    const seller = await prisma.registeredSeller.findUnique({ where: { id: req.params.id } });
    if (!seller || seller.shopperId !== req.user.id) return res.status(404).json({ error: "Seller not found." });
    await prisma.registeredSeller.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listShoppers, getShopper, listSellers, createSeller, deleteSeller };
