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
    const { name, phone, market, bankName, bankCode, accountNumber } = req.body;
    if (!name || !phone || !bankName || !bankCode || !accountNumber) {
      return res.status(400).json({ error: "name, phone, bankName, bankCode, and accountNumber are required." });
    }
    const resolved = await paystack.resolveBankAccount(accountNumber, bankCode);
    const seller = await prisma.registeredSeller.create({
      data: {
        shopperId: req.user.id,
        name,
        phone,
        market,
        bankName,
        bankCode,
        bankAccountNumber: accountNumber,
        bankAccountName: resolved.account_name,
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
