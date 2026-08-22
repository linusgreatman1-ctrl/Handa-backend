const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const commissionSvc = require("../services/commission.service");
const orderFlow = require("../services/orderFlow.service");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

// Resolves a booking's `items` array into a priced snapshot. Each entry is
// either a real catalog item ({menuItemId, qty} — price always looked up
// server-side, never trusted from the client) or a customer-typed "Other"
// request with no matching menu item ({customName, customPriceKobo, qty}
// — used by the meal-picker's free-text row, e.g. "Suya" for a dish not on
// the vendor's menu). Both contribute to the real total the same way.
async function resolveBookingItems(items, vendorId) {
  if (!Array.isArray(items) || !items.length) return { selectedItemsSnapshot: [], itemsTotalKobo: 0 };
  const menuItemIds = items.filter((i) => i.menuItemId).map((i) => i.menuItemId);
  const menuItems = menuItemIds.length ? await prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, vendorId } }) : [];
  let itemsTotalKobo = 0;
  const selectedItemsSnapshot = items.map((reqItem) => {
    const qty = Math.max(1, parseInt(reqItem.qty) || 1);
    if (reqItem.menuItemId) {
      const menuItem = menuItems.find((m) => m.id === reqItem.menuItemId);
      if (!menuItem) throw Object.assign(new Error("One or more items do not belong to this vendor."), { status: 400 });
      itemsTotalKobo += menuItem.priceKobo * qty;
      return { menuItemId: menuItem.id, name: menuItem.name, priceKobo: menuItem.priceKobo, qty };
    }
    const name = (reqItem.customName || "").trim();
    const priceKobo = Math.max(0, Math.round(Number(reqItem.customPriceKobo) || 0));
    if (!name || priceKobo <= 0) throw Object.assign(new Error("A custom item needs both a name and a price."), { status: 400 });
    if (priceKobo > 100000000) throw Object.assign(new Error("Custom item price is unreasonably high."), { status: 400 }); // ₦1,000,000 sanity cap
    itemsTotalKobo += priceKobo * qty;
    return { menuItemId: null, name, priceKobo, qty, custom: true };
  });
  return { selectedItemsSnapshot, itemsTotalKobo };
}

// Bookings cover catering, home-cook, and event-planning requests — custom
// quoted engagements (a package + optional add-on items + an event date),
// unlike Order's fixed-price catalog checkout. Vendor must accept before
// any money moves, matching the "booking request list" the frontend's
// cook/event-planner dashboards show.
async function createBooking(req, res, next) {
  try {
    const { vendorId, type, servicePackageId, items, eventDate, eventTime, venue, guestCount, phone, notes, paymentMethod } = req.body;
    if (!vendorId || !type) return res.status(400).json({ error: "vendorId and type are required." });
    if (!["HOME_COOK", "EVENT_PLANNING"].includes(type)) return res.status(400).json({ error: "Invalid booking type." });

    const vendor = await prisma.vendorProfile.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });

    let totalKobo = 0;
    let servicePackage = null;
    if (servicePackageId) {
      servicePackage = await prisma.servicePackage.findUnique({ where: { id: servicePackageId } });
      if (!servicePackage || servicePackage.vendorId !== vendorId) return res.status(400).json({ error: "Invalid service package for this vendor." });
      totalKobo += servicePackage.priceKobo;
    }

    const { selectedItemsSnapshot, itemsTotalKobo } = await resolveBookingItems(items, vendorId);
    totalKobo += itemsTotalKobo;

    if (totalKobo <= 0) return res.status(400).json({ error: "Booking must include a service package and/or items." });

    const booking = await prisma.booking.create({
      data: {
        bookingNumber: generateReference("BKG"),
        type,
        customerId: req.user.id,
        vendorId,
        servicePackageId: servicePackage?.id,
        selectedItems: selectedItemsSnapshot,
        eventDate: eventDate ? new Date(eventDate) : null,
        eventTime,
        venue,
        guestCount,
        phone,
        notes,
        paymentMethod: paymentMethod || "CARD",
        totalKobo,
      },
    });

    req.app.get("io")?.to(`vendor:${vendorId}`).emit("booking:new", { bookingId: booking.id, vendorId });
    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
}

async function listBookings(req, res, next) {
  try {
    const { as, status } = req.query;
    let where = { customerId: req.user.id };
    if (as === "vendor") {
      if (!req.user.vendorProfile) return res.status(403).json({ error: "No vendor profile found." });
      where = { vendorId: req.user.vendorProfile.id };
    }
    if (status) where.status = status;

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        servicePackage: true,
        customer: { select: { name: true, phone: true, address: true, state: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        vendor: { include: { user: { select: { id: true, name: true, phone: true, address: true } } } },
        servicePackage: true,
        ratings: true,
        customer: { select: { name: true, phone: true, address: true, state: true } },
      },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor && req.user.role !== "ADMIN") return res.status(403).json({ error: "You do not have access to this booking." });

    // Surfaces an in-progress dispute ticket (if any) so either party can
    // see/respond to it without a separate lookup — most recent first,
    // in the rare case more than one was ever filed on this booking.
    const disputeTicket = await prisma.supportTicket.findFirst({
      where: { context: "BOOKING", contextId: booking.id, isDispute: true },
      orderBy: { createdAt: "desc" },
    });

    res.json({ booking, disputeTicket });
  } catch (err) {
    next(err);
  }
}

// Lets the customer amend a booking's date/time/venue/guests/notes/package/
// items any time before the event's own scheduled date — only while it's
// still in a live pre-completion status. The vendor is notified in real
// time so they see the new details, not the ones they originally accepted.
async function updateBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { vendor: { select: { id: true, userId: true } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Only the customer who made this booking can edit it." });
    if (!["REQUESTED", "ACCEPTED", "CONFIRMED"].includes(booking.status)) {
      return res.status(400).json({ error: "This booking can no longer be edited." });
    }
    if (booking.eventDate && new Date(booking.eventDate).getTime() <= Date.now()) {
      return res.status(400).json({ error: "This booking's date has already passed — it can no longer be edited." });
    }

    const { servicePackageId, items, eventDate, eventTime, venue, guestCount, notes } = req.body;
    const data = {};
    if (eventDate !== undefined) data.eventDate = eventDate ? new Date(eventDate) : null;
    if (eventTime !== undefined) data.eventTime = eventTime;
    if (venue !== undefined) data.venue = venue;
    if (guestCount !== undefined) data.guestCount = guestCount;
    if (notes !== undefined) data.notes = notes;

    if (servicePackageId !== undefined || items !== undefined) {
      let totalKobo = 0;
      let newServicePackage = null;
      const pkgId = servicePackageId !== undefined ? servicePackageId : booking.servicePackageId;
      if (pkgId) {
        newServicePackage = await prisma.servicePackage.findUnique({ where: { id: pkgId } });
        if (!newServicePackage || newServicePackage.vendorId !== booking.vendorId) return res.status(400).json({ error: "Invalid service package for this vendor." });
        totalKobo += newServicePackage.priceKobo;
      }
      let newSelectedItems = booking.selectedItems;
      if (items !== undefined) {
        const resolved = await resolveBookingItems(items, booking.vendorId);
        newSelectedItems = resolved.selectedItemsSnapshot;
        totalKobo += resolved.itemsTotalKobo;
      } else {
        totalKobo += (newSelectedItems || []).reduce((sum, i) => sum + i.priceKobo * i.qty, 0);
      }
      if (totalKobo <= 0) return res.status(400).json({ error: "Booking must include a service package and/or items." });
      data.servicePackageId = newServicePackage?.id || null;
      data.selectedItems = newSelectedItems;
      data.totalKobo = totalKobo;
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data });

    if (booking.vendor?.userId) {
      await notify(
        req.app.get("io"),
        booking.vendor.userId,
        "ORDER_UPDATE",
        "Booking details updated",
        `The customer updated booking #${booking.bookingNumber} — check the new details.`,
        { bookingId: booking.id }
      );
    }
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

function assertVendorOwnsBooking(req, booking) {
  if (!req.user.vendorProfile || booking.vendorId !== req.user.vendorProfile.id) {
    const err = new Error("Booking not found.");
    err.status = 404;
    throw err;
  }
}

// Home Cook bookings are paid through the app (escrow) -- acceptance
// moves them to ACCEPTED and the customer is prompted to pay next, same
// as before. Event Planner bookings are paid directly between customer
// and planner, outside the app -- there's nothing for the customer to
// pay here, so acceptance goes straight to CONFIRMED (the same status
// Home Cook only reaches after payment), which is what already unlocks
// the vendor's "Order/Booking Completed" button and the customer's
// eventual Yes/No confirmation, unchanged.
async function acceptBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: `Booking is already ${booking.status.toLowerCase()}.` });

    const isEventPlanning = booking.type === "EVENT_PLANNING";
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: isEventPlanning ? "CONFIRMED" : "ACCEPTED" } });
    const message = isEventPlanning
      ? "Your event planning booking was accepted! Payment is arranged directly with your planner, outside the app."
      : "Your home cook booking was accepted. Pay to confirm your date.";
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking accepted", message, { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

async function declineBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: `Booking is already ${booking.status.toLowerCase()}.` });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "DECLINED" } });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking declined", `Your ${booking.type.toLowerCase().replace("_", " ")} booking request was declined.`, { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Payment only happens once the vendor has accepted and quoted/confirmed
// the engagement — matches the frontend's booking flow (select package →
// details → payment → confirmation) ending on a vendor-approved request.
async function payBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (booking.type === "EVENT_PLANNING") return res.status(400).json({ error: "Event planning bookings are paid directly with the planner, not through the app." });
    if (booking.status !== "ACCEPTED") return res.status(409).json({ error: "This booking has not been accepted by the vendor yet." });

    // The customer can choose their payment method here, at actual pay
    // time -- not be locked into whatever was recorded when the booking
    // was first requested (which may have been a placeholder default).
    const paymentMethod = req.body.paymentMethod || booking.paymentMethod;
    if (paymentMethod !== booking.paymentMethod) {
      await prisma.booking.update({ where: { id: booking.id }, data: { paymentMethod } });
    }

    if (paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, booking.totalKobo, "ESCROW_HOLD", { contextType: "BOOKING", contextId: booking.id, description: "Booking payment" }, tx);
      });
      await orderFlow.confirmBookingPayment(booking.id);
      const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
      return res.json({ booking: updated, paid: true });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/transfer/USSD." });
    const reference = generateReference("BKG");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: booking.totalKobo,
      reference,
      metadata: { purpose: "BOOKING_PAYMENT", bookingId: booking.id },
    });
    res.json({ paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// Two-sided completion, step 1: the vendor (home cook or event planner)
// marks their side done. This does NOT complete the booking or release any
// escrow by itself — it just asks the customer to confirm. See
// confirmBookingCompletion for step 2.
async function completeBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { customer: { select: { id: true } } } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isVendor) return res.status(403).json({ error: "Only the vendor on this booking can mark it complete." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed (paid) before it can be marked complete." });
    if (booking.vendorConfirmedCompleteAt) return res.status(409).json({ error: "You already marked this booking complete — waiting on the customer to confirm." });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { vendorConfirmedCompleteAt: new Date() } });
    await notify(
      req.app.get("io"),
      booking.customerId,
      "ORDER_UPDATE",
      "Confirm your booking is complete",
      `The vendor marked booking #${booking.bookingNumber} as complete. Please confirm so payment can be released.`,
      { bookingId: booking.id }
    );
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Two-sided completion, step 2: the customer's Yes/No response.
// Yes -> booking COMPLETED. For Home Cook, escrow releases (10% platform
// cut, same mechanism as Shop-For-Me's shopper/rider releases — see
// escrow.service.js's PLATFORM_COMMISSION_RATES). For Event Planner,
// there's no escrow to release (payment happened directly with the
// planner, outside the app) -- releaseAllHoldsForContext safely no-ops
// with zero holds, and instead the platform's 10% commission is added
// onto the vendor's own weekly CommissionPeriod (commission.service.js's
// addBookingCommission), which their dashboard already has a real "Pay
// Now" button for.
// No -> booking stays CONFIRMED, a real dispute ticket is opened
// (context BOOKING) and every HELD hold on this booking is pulled out of
// the auto-release sweep via escrow.disputeHold() — the vendor is notified
// and can add their own side via POST /support/tickets/:id/respond; an
// admin resolving that ticket is what finally releases (or doesn't) the
// held funds. (For Event Planner this loop is a no-op since there's
// nothing held, but the dispute ticket + notification still matter.)
async function confirmBookingCompletion(req, res, next) {
  try {
    const { completed, disputeCategory, disputeDescription } = req.body;
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "This booking isn't awaiting completion confirmation." });
    if (!booking.vendorConfirmedCompleteAt) return res.status(409).json({ error: "The vendor hasn't marked this booking complete yet." });
    if (booking.customerConfirmedCompleteAt) return res.status(409).json({ error: "You already responded to this booking's completion." });

    if (completed) {
      await prisma.booking.update({ where: { id: booking.id }, data: { customerConfirmedCompleteAt: new Date() } });
      await escrow.releaseAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: "Booking completion confirmed by customer" });
      if (booking.type === "EVENT_PLANNING") {
        await commissionSvc.addBookingCommission(booking.vendorId, booking.totalKobo);
      }
      const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      const vendor = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });
      if (vendor) {
        const completeMessage = booking.type === "EVENT_PLANNING"
          ? `The customer confirmed booking #${booking.bookingNumber} as completed. Your 10% platform commission for it is now due on your dashboard.`
          : `The customer confirmed booking #${booking.bookingNumber} — payment has been released.`;
        await notify(req.app.get("io"), vendor.userId, "ORDER_UPDATE", "Booking completed", completeMessage, { bookingId: booking.id });
      }
      return res.json({ booking: updated });
    }

    // Disputed — nothing about the booking's own status/holds changes
    // directly here; disputeHold() below is what actually protects the
    // funds from auto-releasing while this is investigated.
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        context: "BOOKING",
        contextId: booking.id,
        category: disputeCategory || "Booking dispute",
        description: disputeDescription || null,
        isDispute: true,
      },
    });
    const holds = await prisma.escrowHold.findMany({ where: { contextType: "BOOKING", bookingId: booking.id, status: "HELD" } });
    for (const hold of holds) await escrow.disputeHold(hold.id);

    const vendor = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });
    if (vendor) {
      await notify(
        req.app.get("io"),
        vendor.userId,
        "ORDER_UPDATE",
        "Customer disputed booking completion",
        `The customer said booking #${booking.bookingNumber} was not completed. Please add your side of what happened.`,
        { bookingId: booking.id, ticketId: ticket.id }
      );
    }
    res.json({ booking, ticket });
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (["COMPLETED", "CANCELLED"].includes(booking.status)) return res.status(409).json({ error: `Booking is already ${booking.status.toLowerCase()}.` });

    if (booking.status === "CONFIRMED") {
      await escrow.refundAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: "Booking cancelled by customer" });
    }
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = { createBooking, listBookings, getBooking, updateBooking, acceptBooking, declineBooking, payBooking, completeBooking, confirmBookingCompletion, cancelBooking };
