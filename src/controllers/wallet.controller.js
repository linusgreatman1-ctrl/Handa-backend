const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");

const MIN_WITHDRAWAL_KOBO = 50000; // ₦500, matches frontend's stated minimum

async function getWallet(req, res, next) {
  try {
    const wallet = await walletSvc.getOrCreateWallet(req.user.id);

    // Powers the vendor/rider "Earnings" tab's daily/weekly/monthly cards —
    // computed on read from Transaction rather than maintained as separate
    // running counters that could drift from the ledger.
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [daily, weekly, monthly, totalEarned, totalWithdrawn, pendingEscrowKobo] = await Promise.all([
      sumPayouts(wallet.id, startOfDay),
      sumPayouts(wallet.id, startOfWeek),
      sumPayouts(wallet.id, startOfMonth),
      sumPayouts(wallet.id, null),
      sumWithdrawn(wallet.id),
      sumHeldEscrow(req.user.id),
    ]);

    res.json({
      balanceKobo: wallet.balanceKobo,
      earnings: { dailyKobo: daily, weeklyKobo: weekly, monthlyKobo: monthly, totalEarnedKobo: totalEarned, totalWithdrawnKobo: totalWithdrawn },
      escrow: { heldKobo: pendingEscrowKobo },
    });
  } catch (err) {
    next(err);
  }
}

async function sumPayouts(walletId, since) {
  const agg = await prisma.transaction.aggregate({
    where: { walletId, type: "PAYOUT", ...(since && { createdAt: { gte: since } }) },
    _sum: { amountKobo: true },
  });
  return agg._sum.amountKobo || 0;
}

async function sumWithdrawn(walletId) {
  const agg = await prisma.transaction.aggregate({
    where: { walletId, type: "WITHDRAWAL" },
    _sum: { amountKobo: true },
  });
  return Math.abs(agg._sum.amountKobo || 0);
}

async function sumHeldEscrow(userId) {
  const agg = await prisma.escrowHold.aggregate({
    where: { payerId: userId, status: "HELD" },
    _sum: { amountKobo: true },
  });
  return agg._sum.amountKobo || 0;
}

// Powers the customer profile's "Escrow Wallet" card — real held/released/
// disputed totals plus a human-readable list of what's currently locked,
// replacing what used to be two hardcoded example rows in the frontend.
async function getEscrowSummary(req, res, next) {
  try {
    const [heldAgg, releasedAgg, disputedAgg, activeHolds] = await Promise.all([
      prisma.escrowHold.aggregate({ where: { payerId: req.user.id, status: "HELD" }, _sum: { amountKobo: true } }),
      prisma.escrowHold.aggregate({ where: { payerId: req.user.id, status: "RELEASED" }, _sum: { amountKobo: true } }),
      prisma.escrowHold.aggregate({ where: { payerId: req.user.id, status: "DISPUTED" }, _sum: { amountKobo: true } }),
      prisma.escrowHold.findMany({
        where: { payerId: req.user.id, status: "HELD" },
        include: {
          order: { include: { vendor: { select: { bizName: true } } } },
          booking: { include: { vendor: { select: { bizName: true } } } },
          shopSession: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const items = activeHolds.map((h) => {
      let label = "Order";
      if (h.contextType === "ORDER" && h.order) label = `${h.order.vendor.bizName} — Order`;
      else if (h.contextType === "BOOKING" && h.booking) label = `${h.booking.vendor.bizName} — ${h.booking.type.replace("_", " ")}`;
      else if (h.contextType === "SHOP_SESSION") label = "Shop-For-Me Session";
      return {
        id: h.id,
        label,
        amountKobo: h.amountKobo,
        payeeRole: h.payeeRole,
        status: `Locked · Awaiting ${h.payeeRole === "PLATFORM" ? "processing" : h.payeeRole.toLowerCase()} confirmation`,
        autoReleaseAt: h.autoReleaseAt,
      };
    });

    res.json({
      heldKobo: heldAgg._sum.amountKobo || 0,
      releasedKobo: releasedAgg._sum.amountKobo || 0,
      disputedKobo: disputedAgg._sum.amountKobo || 0,
      activeHolds: items,
    });
  } catch (err) {
    next(err);
  }
}

async function listTransactions(req, res, next) {
  try {
    const wallet = await walletSvc.getOrCreateWallet(req.user.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, parseInt(req.query.pageSize) || 20);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.transaction.count({ where: { walletId: wallet.id } }),
    ]);
    res.json({ transactions, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

// Debits the wallet immediately (so the balance shown is always accurate)
// then attempts the real bank transfer — if Paystack itself fails to
// even accept the transfer request, the debit is reversed synchronously;
// if it's accepted but fails later, the transfer.failed webhook reverses
// it (see orderFlow.applyTransferWebhook).
async function requestWithdrawal(req, res, next) {
  try {
    const { amountKobo } = req.body;
    if (!amountKobo || amountKobo < MIN_WITHDRAWAL_KOBO) {
      return res.status(400).json({ error: `Minimum withdrawal is ₦${MIN_WITHDRAWAL_KOBO / 100}.` });
    }
    if (!req.user.bankAccountNumber || !req.user.bankName) {
      return res.status(400).json({ error: "Link a bank account before withdrawing." });
    }

    const wallet = await walletSvc.getOrCreateWallet(req.user.id);
    const reference = generateReference("WDR");

    const withdrawal = await prisma.$transaction(async (tx) => {
      await walletSvc.debitWallet(req.user.id, amountKobo, "WITHDRAWAL", { reference, description: "Withdrawal to bank account" }, tx);
      return tx.withdrawal.create({
        data: {
          userId: req.user.id,
          walletId: wallet.id,
          amountKobo,
          bankName: req.user.bankName,
          bankAccountNumber: req.user.bankAccountNumber,
          bankAccountName: req.user.bankAccountName || req.user.name,
        },
      });
    });

    try {
      const recipient = await paystack.createTransferRecipient({
        name: req.user.bankAccountName || req.user.name,
        accountNumber: req.user.bankAccountNumber,
        bankCode: req.body.bankCode,
      });
      const transfer = await paystack.initiateTransfer({
        amountKobo,
        recipientCode: recipient.recipient_code,
        reason: "Handa wallet withdrawal",
        reference,
      });
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: "PROCESSING", paystackTransferCode: transfer.transfer_code },
      });
      return res.status(201).json({ withdrawal: { ...withdrawal, status: "PROCESSING" }, etaMinutes: 120 });
    } catch (transferErr) {
      await prisma.$transaction(async (tx) => {
        await walletSvc.creditWallet(req.user.id, amountKobo, "ADJUSTMENT", { description: "Withdrawal failed to initiate — reversed" }, tx);
        await tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "FAILED", failureReason: transferErr.message } });
      });
      return res.status(502).json({ error: "Could not reach the payout provider. Your balance has been restored." });
    }
  } catch (err) {
    next(err);
  }
}

async function listWithdrawals(req, res, next) {
  try {
    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: req.user.id }, orderBy: { requestedAt: "desc" } });
    res.json({ withdrawals });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWallet, listTransactions, requestWithdrawal, listWithdrawals, getEscrowSummary };
