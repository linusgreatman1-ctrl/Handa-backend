const prisma = require("../config/db");

const COMMISSION_PERCENT = Number(process.env.VENDOR_COMMISSION_PERCENT || 10);

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// Historically this billed a weekly 10% debt invoice on every completed
// booking, on the assumption the vendor was paid the FULL booking amount
// and owed the commission back separately. That's no longer true: every
// booking that reaches COMPLETED does so through confirmBookingCompletion
// (bookings.controller.js), which already deducts the platform's 10% cut
// in real time out of escrow at release (see PLATFORM_COMMISSION_RATES.VENDOR
// in escrow.service.js) — the only path that ever sets a booking to
// COMPLETED. Re-billing the full undiscounted totalKobo here on top of
// that would double-charge the vendor for the same booking. The weekly
// period record is kept (the vendor dashboard's "commission" card and the
// admin Reports/Commissions tabs still read it) but always reflects 0 due
// for bookings, since nothing is actually owed after real-time deduction.
async function getOrCreateCurrentPeriod(vendorId) {
  const periodStart = startOfWeek(new Date());
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + 7);

  let period = await prisma.commissionPeriod.findFirst({ where: { vendorId, periodStart } });
  if (period) return period;

  return prisma.commissionPeriod.create({ data: { vendorId, periodStart, periodEnd, amountDueKobo: 0 } });
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
