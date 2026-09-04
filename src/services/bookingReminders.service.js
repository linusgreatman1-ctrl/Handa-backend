const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_MS = 2 * 60 * 60 * 1000;
// sendCompletionReminders is intentionally repeating (nudges until the
// booking is confirmed complete) -- but with no throttle it fired on every
// 5-minute sweep tick, producing dozens of identical notifications in a
// few hours (the "39 notifications" report). This caps re-sends to once
// per window instead.
const COMPLETION_REMINDER_INTERVAL_MS = 3 * 60 * 60 * 1000;
// How wide a window each sweep tick checks — must be at least as long as
// the sweep interval (5 min, matching live.js's other sweeps) so a
// booking's due moment is never skipped between two ticks.
const WINDOW_MS = 10 * 60 * 1000;

// eventTime is a free-text field (e.g. "7:00 PM", "19:00"), not part of a
// real DateTime — combine it with eventDate ourselves. Falls back to
// midnight on eventDate if eventTime doesn't parse.
function combineDateAndTime(eventDate, eventTime) {
  const base = new Date(eventDate);
  if (!eventTime) return base;
  const match = String(eventTime).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return base;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3] ? match[3].toUpperCase() : null;
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  const combined = new Date(base);
  combined.setHours(hours, minutes, 0, 0);
  return combined;
}

async function sendUpcomingReminders(io) {
  const now = Date.now();
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["ACCEPTED", "CONFIRMED"] },
      eventDate: { not: null },
      OR: [{ reminder24SentAt: null }, { reminder2SentAt: null }],
    },
    include: { vendor: { select: { userId: true, bizName: true } } },
  });

  let sent = 0;
  for (const booking of bookings) {
    const eventInstant = combineDateAndTime(booking.eventDate, booking.eventTime).getTime();
    const msUntil = eventInstant - now;

    if (!booking.reminder24SentAt && msUntil > 0 && Math.abs(msUntil - REMINDER_24H_MS) <= WINDOW_MS) {
      await notify(
        io,
        booking.vendor.userId,
        "ORDER_UPDATE",
        "Booking tomorrow",
        `You have a booking (#${booking.bookingNumber}) coming up in about 24 hours.`,
        { bookingId: booking.id }
      );
      await prisma.booking.update({ where: { id: booking.id }, data: { reminder24SentAt: new Date() } });
      sent++;
      continue;
    }

    if (!booking.reminder2SentAt && msUntil > 0 && Math.abs(msUntil - REMINDER_2H_MS) <= WINDOW_MS) {
      await notify(
        io,
        booking.vendor.userId,
        "ORDER_UPDATE",
        "Booking in 2 hours",
        `You have a booking (#${booking.bookingNumber}) coming up in about 2 hours.`,
        { bookingId: booking.id }
      );
      await prisma.booking.update({ where: { id: booking.id }, data: { reminder2SentAt: new Date() } });
      sent++;
    }
  }
  return sent;
}

// 2 hours after a booking's own scheduled time has elapsed, if it still
// hasn't reached COMPLETED (i.e. the vendor-marks-complete /
// customer-confirms two-sided flow in bookings.controller.js hasn't
// finished), nudge both sides every sweep tick — repeating, not one-shot,
// matching "popping up... reminding... until the booking is confirmed."
// A booking that's disputed (still CONFIRMED, but vendorConfirmedCompleteAt
// is already set) also keeps getting reminded, since it's genuinely not
// resolved yet either.
async function sendCompletionReminders(io) {
  const now = Date.now();
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["ACCEPTED", "CONFIRMED"] },
      eventDate: { not: null },
    },
    include: { vendor: { select: { userId: true } } },
  });

  let sent = 0;
  for (const booking of bookings) {
    const eventInstant = combineDateAndTime(booking.eventDate, booking.eventTime).getTime();
    if (now - eventInstant < REMINDER_2H_MS) continue; // not yet 2h past
    if (booking.lastCompletionReminderAt && now - booking.lastCompletionReminderAt.getTime() < COMPLETION_REMINDER_INTERVAL_MS) continue;

    if (!booking.vendorConfirmedCompleteAt) {
      await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Confirm this booking is complete", `Booking #${booking.bookingNumber}'s scheduled time has passed — please mark it complete.`, { bookingId: booking.id });
      await prisma.booking.update({ where: { id: booking.id }, data: { lastCompletionReminderAt: new Date() } });
      sent++;
    } else if (!booking.customerConfirmedCompleteAt) {
      await notify(io, booking.customerId, "ORDER_UPDATE", "Confirm your booking is complete", `The vendor marked booking #${booking.bookingNumber} complete — please confirm.`, { bookingId: booking.id });
      await prisma.booking.update({ where: { id: booking.id }, data: { lastCompletionReminderAt: new Date() } });
      sent++;
    }
  }
  return sent;
}

// Event Planner has no "Start Job" stage and no customer Yes/No step --
// completeBooking's EP branch ends the whole booking the moment the
// vendor taps Mark Job Complete. If they never tap it at all, the booking
// (and the EP's own 10% commission on it) would otherwise sit open
// forever, unlike Home Cook which at least keeps nudging both sides via
// sendCompletionReminders above. 24h past the scheduled event time, this
// closes it out automatically using the exact same escrow-release +
// commission logic completeBooking already runs (see
// bookings.controller.js's completeEventPlanningBooking), so there's no
// separate code path to keep in sync.
const AUTO_COMPLETE_EP_MS = 24 * 60 * 60 * 1000;
// The "Today is event day" row write-up (renderVendorBookingsList,
// frontend) is computed live from eventDate on every render -- no
// backend involvement needed for the TEXT. This sweep only handles the
// separate, explicit real-time NOTIFICATION the EP should get the day
// their event arrives ("it sends a notification to the ep about the
// event"), which the frontend can't originate on its own. Compares
// calendar dates only (not eventTime) since "today is event day" is a
// day-level concept, not a specific instant -- matches how eventDate is
// already displayed everywhere else in this app (toLocaleDateString(),
// never combined with eventTime for date comparisons except in the
// duration-based sweeps above, which are checking elapsed time, not
// calendar day).
async function sendEventDayReminders(io) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      type: "EVENT_PLANNING",
      status: "CONFIRMED",
      eventDayNotifiedAt: null,
      eventDate: { gte: todayStart, lt: todayEnd },
    },
    include: { vendor: { select: { userId: true } } },
  });

  let sent = 0;
  for (const booking of bookings) {
    await notify(
      io,
      booking.vendor.userId,
      "ORDER_UPDATE",
      "Today is your event",
      `Today is the scheduled date for booking #${booking.bookingNumber} — mark it complete once it's done.`,
      { bookingId: booking.id }
    );
    await prisma.booking.update({ where: { id: booking.id }, data: { eventDayNotifiedAt: new Date() } });
    sent++;
  }
  return sent;
}

async function autoCompleteOverdueEventPlannerBookings(io) {
  // Required lazily to avoid a require-cycle at module-load time --
  // bookings.controller.js's own top-level requires never touch this
  // file, but requiring it eagerly at the top here isn't necessary either
  // way since this function is only ever called from the sweep, well
  // after both modules have finished loading.
  const bookingsCtrl = require("../controllers/bookings.controller");
  const now = Date.now();
  const bookings = await prisma.booking.findMany({
    where: { type: "EVENT_PLANNING", status: "CONFIRMED", eventDate: { not: null }, vendorConfirmedCompleteAt: null },
  });

  let completed = 0;
  for (const booking of bookings) {
    const eventInstant = combineDateAndTime(booking.eventDate, booking.eventTime).getTime();
    if (now - eventInstant < AUTO_COMPLETE_EP_MS) continue;
    // EP bookings now go through the negotiated-release flow
    // (bookings.controller.js's isNegotiatedBooking) -- calling
    // completeEventPlanningBooking releases WHATEVER remains in the
    // escrow hold, which for a booking still mid-negotiation (nothing
    // ever released) would be the entire amount, dumped to the vendor
    // with no negotiation ever having concluded. Mirrors completeBooking's
    // own new guard: skip (don't auto-complete) any booking whose job
    // never started -- same "no timer for an unstarted job" tradeoff
    // accepted for the hold's own autoRelease:false (orderFlow.service.js).
    // These accumulate for manual admin follow-up instead.
    if (!booking.vendorJobStartedAt) continue;
    await bookingsCtrl.completeEventPlanningBooking(booking, io, "Event planning booking auto-completed 24h after the scheduled event -- vendor never marked it complete.");
    completed++;
  }
  return completed;
}

module.exports = { sendUpcomingReminders, sendCompletionReminders, sendEventDayReminders, autoCompleteOverdueEventPlannerBookings, combineDateAndTime };
