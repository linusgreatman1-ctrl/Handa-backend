const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_MS = 2 * 60 * 60 * 1000;
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

    if (!booking.vendorConfirmedCompleteAt) {
      await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Confirm this booking is complete", `Booking #${booking.bookingNumber}'s scheduled time has passed — please mark it complete.`, { bookingId: booking.id });
      sent++;
    } else if (!booking.customerConfirmedCompleteAt) {
      await notify(io, booking.customerId, "ORDER_UPDATE", "Confirm your booking is complete", `The vendor marked booking #${booking.bookingNumber} complete — please confirm.`, { bookingId: booking.id });
      sent++;
    }
  }
  return sent;
}

module.exports = { sendUpcomingReminders, sendCompletionReminders, combineDateAndTime };
