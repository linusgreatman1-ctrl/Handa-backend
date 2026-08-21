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

module.exports = { sendUpcomingReminders, combineDateAndTime };
