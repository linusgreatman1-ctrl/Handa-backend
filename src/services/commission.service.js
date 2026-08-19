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

// Periodic sweep (see src/realtime/live.js, same interval as the escrow
// auto-release sweep): a PENDING period whose periodEnd has passed and
// still isn't fully paid becomes OVERDUE. Nothing else in the app ever
// transitions a period out of PENDING except a full payment (see
// orderFlow.service.js's confirmCommissionPayment, which sets PAID) —
// without this sweep, CommissionPeriod.status:OVERDUE could never occur,
// so the admin Reports tab's "Overdue" bucket would always read zero.
async function markOverduePeriods() {
  const { count } = await prisma.commissionPeriod.updateMany({
    where: { status: "PENDING", periodEnd: { lt: new Date() } },
    data: { status: "OVERDUE" },
  });
  return count;
}

module.exports = { getOrCreateCurrentPeriod, markOverduePeriods };
