const prisma = require("../config/db");

const COMMISSION_PERCENT = Number(process.env.VENDOR_COMMISSION_PERCENT || 10);

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// Home cooks & event planners owe a weekly 10% commission on completed
// bookings, separate from per-order escrow (they're paid the full booking
// amount, then owe this back to the platform — matches the frontend's
// "Weekly commission due" card, which is a debt notice, not a deduction
// taken automatically at payout).
async function getOrCreateCurrentPeriod(vendorId) {
  const periodStart = startOfWeek(new Date());
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + 7);

  let period = await prisma.commissionPeriod.findFirst({ where: { vendorId, periodStart } });
  if (period) return period;

  const completed = await prisma.booking.findMany({
    where: { vendorId, status: "COMPLETED", completedAt: { gte: periodStart, lt: periodEnd } },
  });
  const amountDueKobo = Math.round(completed.reduce((sum, b) => sum + b.totalKobo, 0) * (COMMISSION_PERCENT / 100));

  return prisma.commissionPeriod.create({ data: { vendorId, periodStart, periodEnd, amountDueKobo } });
}

module.exports = { getOrCreateCurrentPeriod };
