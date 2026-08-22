const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const orderFlow = require("../services/orderFlow.service");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

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

    let selectedItemsSnapshot = [];
    if (Array.isArray(items) && items.length) {
      const menuItems = await prisma.menuItem.findMany({ where: { id: { in: items.map((i) => i.menuItemId) }, vendorId } });
      selectedItemsSnapshot = items.map((reqItem) => {
        const menuItem = menuItems.find((m) => m.id === reqItem.menuItemId);
        if (!menuItem) throw Object.assign(new Error("One or more items do not belong to this vendor."), { status: 400 });
        const qty = Math.max(1, parseInt(reqItem.qty) || 1);
        totalKobo += menuItem.priceKobo * qty;
        return { menuItemId: menuItem.id, name: menuItem.name, priceKobo: menuItem.priceKobo, qty };
      });
    }

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
        vendor: { include: { user: { select: { name: true, phone: true, address: true } } } },
        servicePackage: true,
        ratings: true,
        customer: { select: { name: true, phone: true, address: true, state: true } },
      },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor && req.user.role !== "ADMIN") return res.status(403).json({ error: "You do not have access to this booking." });

    res.json({ booking });
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
        if (Array.isArray(items) && items.length) {
          const menuItems = await prisma.menuItem.findMany({ where: { id: { in: items.map((i) => i.menuItemId) }, vendorId: booking.vendorId } });
          newSelectedItems = items.map((reqItem) => {
            const menuItem = menuItems.find((m) => m.id === reqItem.menuItemId);
            if (!menuItem) throw Object.assign(new Error("One or more items do not belong to this vendor."), { status: 400 });
            const qty = Math.max(1, parseInt(reqItem.qty) || 1);
            return { menuItemId: menuItem.id, name: menuItem.name, priceKobo: menuItem.priceKobo, qty };
          });
        } else {
          newSelectedItems = [];
        }
      }
      totalKobo += (newSelectedItems || []).reduce((sum, i) => sum + i.priceKobo * i.qty, 0);
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

async function acceptBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: `Booking is already ${booking.status.toLowerCase()}.` });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "ACCEPTED" } });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking accepted", `Your ${booking.type.toLowerCase().replace("_", " ")} booking was accepted. Pay to confirm your date.`, { bookingId: booking.id });
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

async function completeBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor) return res.status(403).json({ error: "You do not have access to this booking." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed (paid) before it can be completed." });

    await escrow.releaseAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: "Booking marked complete" });
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    res.json({ booking: updated });
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

module.exports = { createBooking, listBookings, getBooking, updateBooking, acceptBooking, declineBooking, payBooking, completeBooking, cancelBooking };
