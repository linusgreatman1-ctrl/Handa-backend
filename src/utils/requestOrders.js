const prisma = require("../config/db");

// Event/Catering/Cake requests become a real Booking once a proposal is
// accepted (proposal.bookingId). Request lists only knew the request's own
// status, so an accepted request read "waiting for feedback" forever and a
// completed/cancelled order was indistinguishable from a fresh one. This
// attaches `order: { id, status }` (the Booking it became) to each request,
// taking the booking id from the proposal(s) the list already loaded:
//   customer lists -> the accepted proposal
//   vendor lists   -> the vendor's own proposal
async function attachRequestOrders(requests) {
  const idFor = (r) => ((r.proposals || []).find((p) => p.bookingId) || {}).bookingId || null;
  const ids = requests.map(idFor).filter(Boolean);
  const bookings = ids.length
    ? await prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, type: true } })
    : [];
  const byId = Object.fromEntries(bookings.map((b) => [b.id, b]));
  for (const r of requests) {
    const id = idFor(r);
    r.order = id && byId[id] ? byId[id] : null;
  }
  return requests;
}

module.exports = { attachRequestOrders };
