const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const orderFlow = require("../services/orderFlow.service");
const manualPayments = require("../services/manualPayments.service");
const { closeSupportThreadForContext } = require("./chat.controller");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");
const { generateOtpCode } = require("../utils/otp");
const distanceFee = require("../utils/distanceFee");

// pickupCode/deliveryCode only mean anything as a spoken-in-person check --
// the vendor reads pickupCode aloud to the rider at handover, the customer
// reads deliveryCode aloud at drop-off. Handing either straight to the
// rider's own client (the default Prisma serialization would, since
// they're plain scalar columns with no field-level access control) lets
// the rider skip ever actually being at the right place to ask, so both
// are stripped from any booking object served to the assigned rider. Same
// idea as the handover-code stripping already done for ShopSession.
function stripRiderCodes(booking) {
  if (!booking) return booking;
  const { pickupCode, deliveryCode, ...rest } = booking;
  return rest;
}

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
    // The customer's own note on what a free-text "Other" dish should
    // contain per head (drinks or not, which kind) -- there's no catalog
    // item's `contents` to describe it, so it travels with the order.
    const notes = reqItem.customNotes ? String(reqItem.customNotes).trim().slice(0, 500) : undefined;
    return { menuItemId: null, name, priceKobo, qty, custom: true, ...(notes && { notes }) };
  });
  return { selectedItemsSnapshot, itemsTotalKobo };
}

// The real root cause of this cap "not working": a fixed-template EP
// package (Basic/Standard/Premium/Birthday) created via the vendor's
// "quick add" flow, or seeded directly, can carry a null guestCount even
// though its own customer-facing card text ("Up to 200 guests" etc.) is a
// hardcoded template description that never changes -- the promised cap
// and the enforced cap silently diverge the moment guestCount is null.
// Mirrors the frontend's own _epPackages template defaults exactly, so a
// package whose real guestCount was never set (or was cleared) still gets
// the cap its own card text promises, instead of silently becoming
// unlimited. Wedding/Corporate/Burial/Naming make no "Up to N" claim in
// their template text, so they get no fallback here either.
const EP_TEMPLATE_GUEST_DEFAULTS = { BASIC: 100, STANDARD: 200, PREMIUM: 500, BIRTHDAY: 150 };

// Never let a stored guestCount exceed the package's own configured max --
// authoritative server-side clamp. A client-side oninput clamp alone can't
// be trusted as the sole enforcement (bypassable by any direct API call,
// and belt-and-suspenders against whatever client-side quirk keeps making
// this look broken to the user).
function clampGuestCount(guestCount, servicePackage) {
  if (guestCount == null || guestCount === "") return guestCount;
  const n = parseInt(guestCount);
  if (!Number.isFinite(n)) return guestCount;
  if (servicePackage) {
    const cap = servicePackage.guestCount || EP_TEMPLATE_GUEST_DEFAULTS[servicePackage.key];
    if (cap) return Math.min(n, cap);
  }
  return n;
}

// Event Planner bookings (always), standalone CATERING bookings (always --
// the old Home Cook "Event Catering Package" packageKey "premium" special
// case now lives here as its own vendor type), and any lingering pre-split
// Home Cook "premium" packageKey booking go through the negotiated-release
// flow instead of an all-or-nothing escrow payout: full payment still
// happens upfront (see orderFlow.confirmBookingPayment), but the vendor is
// paid out in stages the customer controls (engageBooking/
// endBookingConversation/releaseBookingPayment/requestAdditionalPayment/
// respondAdditionalPayment, below), with whatever remains at completion
// paying out through the existing completion flow unchanged.
function isNegotiatedBooking(booking) {
  return booking.type === "EVENT_PLANNING" || booking.type === "CATERING" || booking.packageKey === "premium";
}

const BOOKING_TYPE_LABEL = { EVENT_PLANNING: "event planning", CATERING: "catering", CAKE: "cake", HOME_COOK: "home cook" };
function bookingTypeLabel(type) {
  return BOOKING_TYPE_LABEL[type] || "home cook";
}

// Bookings cover catering, home-cook, and event-planning requests — custom
// quoted engagements (a package + optional add-on items + an event date),
// unlike Order's fixed-price catalog checkout. Vendor must accept before
// any money moves, matching the "booking request list" the frontend's
// cook/event-planner dashboards show.
// Same pricing as Shop-For-Me's predicted rider fee: real road distance via
// Google Routes (baker's address -> delivery address) when configured,
// otherwise distanceFee.js's state/LGA estimate (baker's registered area ->
// customer's), both priced by the same feeKoboFromDistanceKm.
async function estimateCakeRiderFee(vendorId, deliveryAddress, customerId) {
  const vendor = await prisma.vendorProfile.findUnique({ where: { id: vendorId }, include: { user: { select: { address: true, state: true, lga: true } } } });
  const vu = (vendor && vendor.user) || {};
  const cu = (await prisma.user.findUnique({ where: { id: customerId }, select: { state: true, lga: true } })) || {};
  if (deliveryAddress && (vu.address || vu.state)) {
    try {
      const origin = [vu.address, vu.lga, vu.state, "Nigeria"].filter(Boolean).join(", ");
      const { distanceKm } = await require("../services/googleRoutes.service").computeRouteDistanceKm(origin, `${deliveryAddress}, Nigeria`);
      return { feeKobo: distanceFee.feeKoboFromDistanceKm(distanceKm), distanceKm: Math.round(distanceKm * 10) / 10 };
    } catch (err) {
      // No GOOGLE_MAPS_API_KEY / unresolvable address -> estimate below.
    }
  }
  return distanceFee.estimateRiderFeeKobo({ state: vu.state, lga: vu.lga }, { state: cu.state, lga: cu.lga });
}

// GET /bookings/cake-delivery-fee?vendorId=&address= -- the checkout's live
// "Rider delivery fee" line, priced exactly as createBooking will charge it.
async function getCakeDeliveryFee(req, res, next) {
  try {
    const { vendorId, address } = req.query;
    if (!vendorId) return res.status(400).json({ error: "vendorId is required." });
    res.json(await estimateCakeRiderFee(vendorId, address, req.user.id));
  } catch (err) {
    next(err);
  }
}

async function createBooking(req, res, next) {
  try {
    const { vendorId, type, servicePackageId, items, eventDate, eventTime, venue, guestCount, phone, notes, paymentMethod, packageKey, packageLabel, eventType } = req.body;
    if (!vendorId || !type) return res.status(400).json({ error: "vendorId and type are required." });
    if (!["HOME_COOK", "EVENT_PLANNING", "CATERING", "CAKE"].includes(type)) return res.status(400).json({ error: "Invalid booking type." });

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

    // CAKE: the rider's delivery fee is priced upfront (baker -> delivery
    // address) and paid into escrow with the cake, exactly like a
    // Shop-For-Me deposit carries its riderFeeKobo from the start.
    let riderFeeKobo = null;
    if (type === "CAKE") {
      ({ feeKobo: riderFeeKobo } = await estimateCakeRiderFee(vendorId, venue, req.user.id));
      totalKobo += riderFeeKobo;
    }

    const booking = await prisma.booking.create({
      data: {
        bookingNumber: generateReference("BKG"),
        type,
        customerId: req.user.id,
        vendorId,
        servicePackageId: servicePackage?.id,
        // Only meaningful (and only ever sent by the frontend) when there's
        // no real servicePackageId -- a meal-picker package's own display
        // name, so "Package" in booking details isn't always "--" for those.
        packageKey: servicePackage ? null : (packageKey ? String(packageKey).slice(0, 60) : null),
        packageLabel: servicePackage ? null : (packageLabel ? String(packageLabel).slice(0, 120) : null),
        selectedItems: selectedItemsSnapshot,
        eventDate: eventDate ? new Date(eventDate) : null,
        eventTime,
        venue,
        guestCount: clampGuestCount(guestCount, servicePackage),
        phone,
        eventType: eventType ? String(eventType).slice(0, 60) : null,
        notes,
        paymentMethod: paymentMethod || "CARD",
        totalKobo,
        ...(riderFeeKobo != null && { riderFeeKobo }),
      },
      include: { servicePackage: true },
    });

    // Every booking is unpaid at this exact moment (payment happens in a
    // separate step right after creation, see payBooking/
    // confirmBookingPayment) -- notifying the vendor here would tell them
    // about a request before the customer has actually paid for it, which
    // is exactly the "shouldn't be able to see it before payment" gap.
    // confirmBookingPayment (orderFlow.service.js) sends the real
    // "New paid booking request" notify once payment actually clears. This
    // used to notify immediately for EVENT_PLANNING (back when EP never
    // paid through the app at all) -- now that EP pays upfront too, same
    // as Home Cook, it follows the identical "don't notify until paid"
    // pattern with no special case here.
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
      // An order the customer never paid for (REQUESTED) isn't a real order
      // yet -- vendors are never shown it, same rule as the "New paid
      // booking request" notify only firing once payment clears.
      where = {
        vendorId: req.user.vendorProfile.id,
        status: { not: "REQUESTED" },
        NOT: { status: "CANCELLED", cancelReason: "Payment not completed" },
      };
    } else if (as === "rider") {
      // A rider's own accepted CAKE deliveries -- available (not-yet-
      // accepted) ones are a separate lookup, listAvailableCakeDeliveries.
      if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
      where = { riderId: req.user.riderProfile.id };
    }
    if (status) where.status = status;

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        servicePackage: true,
        customer: { select: { name: true, phone: true, address: true, state: true } },
        rider: { include: { user: { select: { id: true, name: true, phone: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Batched dispute lookup so the dashboard list cards' own write-up
    // (_vendorBookingWriteup/_customerBookingWriteup) can show "Payment
    // Disputed"/"Dispute Is Pending Resolve From Handa"/"Dispute has been
    // resolved" without a per-row detail fetch -- getBooking already does
    // this single-booking, this is the same lookup batched across the
    // whole list. Only the latest BOOKING-context dispute ticket per
    // booking is kept (a booking can only ever have one live dispute at a
    // time in practice, but findMany + reduce is cheap insurance against
    // that ever not holding).
    const bookingIds = bookings.map((b) => b.id);
    if (bookingIds.length > 0) {
      const disputeTickets = await prisma.supportTicket.findMany({
        where: { context: "BOOKING", contextId: { in: bookingIds }, isDispute: true },
        orderBy: { createdAt: "desc" },
        select: { contextId: true, status: true },
      });
      const disputeStatusByBookingId = {};
      for (const t of disputeTickets) {
        if (!disputeStatusByBookingId[t.contextId]) disputeStatusByBookingId[t.contextId] = t.status;
      }
      for (const b of bookings) {
        b.disputeStatus = disputeStatusByBookingId[b.id] || null;
      }
    }

    res.json({ bookings: as === "rider" ? bookings.map(stripRiderCodes) : bookings });
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
        customer: { select: { id: true, name: true, phone: true, address: true, state: true } },
        rider: { include: { user: { select: { id: true, name: true, phone: true, avatarUrl: true } } } },
      },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    // CAKE bookings add a third real party once a rider accepts the
    // delivery (booking.riderId) -- every other booking type's rider stays
    // null, so this is always false for them.
    const isRider = req.user.riderProfile && booking.riderId === req.user.riderProfile.id;
    if (!isCustomer && !isVendor && !isRider && req.user.role !== "ADMIN") return res.status(403).json({ error: "You do not have access to this booking." });

    // Surfaces an in-progress dispute ticket (if any) so either party can
    // see/respond to it without a separate lookup — most recent first,
    // in the rare case more than one was ever filed on this booking.
    const disputeTicket = await prisma.supportTicket.findFirst({
      where: { context: "BOOKING", contextId: booking.id, isDispute: true },
      orderBy: { createdAt: "desc" },
    });

    // Any plain "Report Issues" ticket on this booking (dispute or not) --
    // separate from disputeTicket above, which is specifically the
    // job-not-completed dispute flow. Lets the frontend swap the Report
    // Issues button for a static "Issue Reported" state instead of
    // letting the same booking be reported over and over.
    const reportTicket = await prisma.supportTicket.findFirst({
      where: { context: "BOOKING", contextId: booking.id },
      orderBy: { createdAt: "desc" },
    });

    // The real remaining held balance, for the negotiated-release flow's
    // "Release Payment" input to cap itself against without a second call
    // -- 0 once nothing (or nothing more) is held, whether because it was
    // never a negotiated booking or the hold's already fully drained.
    const vendorHold = await prisma.escrowHold.findFirst({ where: { bookingId: booking.id, payeeRole: "VENDOR", status: "HELD" } });

    // Which parties THIS viewer has already reported on this order, so each
    // per-party Report button (Report Baker / Report Rider / Report Customer)
    // can show its own "reported" state. Ticket context names the party:
    // BOOKING/VENDOR = the vendor, RIDER = the rider, CUSTOMER = the customer.
    const mine = await prisma.supportTicket.findMany({
      where: { userId: req.user.id, contextId: booking.id, context: { in: ["BOOKING", "VENDOR", "RIDER", "CUSTOMER"] } },
      select: { context: true },
    });
    const myReports = {};
    for (const t of mine) myReports[t.context === "BOOKING" ? "VENDOR" : t.context] = true;

    res.json({ booking: isRider ? stripRiderCodes(booking) : booking, disputeTicket, reportTicket, myReports, escrowHoldRemainingKobo: vendorHold ? vendorHold.amountKobo : 0 });
  } catch (err) {
    next(err);
  }
}

// Builds the same {servicePackageId, selectedItems, totalKobo, ...} shape
// updateBooking used to apply directly — now shared between "apply now"
// (pre-accept) and "hold for vendor approval" (post-accept) paths.
async function buildBookingEditData(booking, body) {
  const { servicePackageId, items, eventDate, eventTime, venue, guestCount, notes } = body;
  const data = {};
  if (eventDate !== undefined) data.eventDate = eventDate ? new Date(eventDate) : null;
  if (eventTime !== undefined) data.eventTime = eventTime;
  if (venue !== undefined) data.venue = venue;
  if (notes !== undefined) data.notes = notes;

  let newServicePackage = null;
  // Event Planning's own "Items Booked" edit fields (epItemsField) only
  // ever rename an existing service label in place -- "its price stays
  // the same" per that UI's own copy -- because these items are purely
  // descriptive (what a won proposal's servicesRequested/servicesIncluded
  // merged into, see eventRequests.controller.js's acceptProposal); the
  // booking's real total is the proposal's own negotiated lump sum, never
  // a sum of per-item prices. Routing this through resolveBookingItems
  // (which requires every custom item to have a real priceKobo > 0, and
  // resums the total from item prices) would both reject these zero-priced
  // labels outright AND -- if that check were merely relaxed -- silently
  // zero out the real total on any items-only edit. Renaming keeps each
  // item's own already-carried-forward price (data-price on the frontend
  // input, unchanged) and never touches totalKobo at all.
  if ((booking.type === "EVENT_PLANNING" || booking.type === "CATERING") && items !== undefined) {
    const renamed = items
      .map((it) => ({
        name: (it.customName || "").trim(),
        priceKobo: Math.max(0, Math.round(Number(it.customPriceKobo) || 0)),
        qty: Math.max(1, parseInt(it.qty) || 1),
        custom: true,
      }))
      .filter((it) => it.name);
    if (!renamed.length) throw Object.assign(new Error("At least one item is required."), { status: 400 });
    data.selectedItems = renamed;
  } else if (servicePackageId !== undefined || items !== undefined) {
    let totalKobo = 0;
    const pkgId = servicePackageId !== undefined ? servicePackageId : booking.servicePackageId;
    if (pkgId) {
      newServicePackage = await prisma.servicePackage.findUnique({ where: { id: pkgId } });
      if (!newServicePackage || newServicePackage.vendorId !== booking.vendorId) throw Object.assign(new Error("Invalid service package for this vendor."), { status: 400 });
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
    if (totalKobo <= 0) throw Object.assign(new Error("Booking must include a service package and/or items."), { status: 400 });
    // CAKE's total also carries the rider fee collected upfront -- an item
    // edit only changes the cake part.
    if (booking.type === "CAKE") totalKobo += booking.riderFeeKobo || 0;
    data.servicePackageId = newServicePackage?.id || null;
    data.selectedItems = newSelectedItems;
    data.totalKobo = totalKobo;
  }

  if (guestCount !== undefined) {
    // Clamp against whichever package actually governs this edit -- the
    // newly-selected one if this same edit also changed it, otherwise the
    // booking's existing package (fetched only if not already fetched above).
    const relevantPackage = newServicePackage || (booking.servicePackageId ? await prisma.servicePackage.findUnique({ where: { id: booking.servicePackageId } }) : null);
    data.guestCount = clampGuestCount(guestCount, relevantPackage);
  }
  return data;
}

// A booking already paid (REQUESTED has no hold yet -- payBooking will
// simply collect whatever totalKobo is current whenever it happens) has a
// real EscrowHold sized to the OLD total. Editing items/package can move
// totalKobo without ever touching that hold unless this runs -- silently
// leaving the vendor's eventual payout drifted from what the booking now
// says it costs. Increases require the difference to actually be
// collected from the customer's escrow wallet up front (dryRun just
// checks the balance without charging, for a live preview/precheck before
// the edit is even submitted, or before a CONFIRMED booking's edit is
// merely proposed); decreases refund the difference back. Throws
// {status:400, shortfallKobo} on insufficient balance -- the caller must
// not apply/charge anything else in that case.
//
// A negotiated booking (isNegotiatedBooking) can have already released
// part of its escrow to the vendor by the time an edit happens (editing
// stays allowed throughout -- only cancellation locks once any part
// payment has released, see cancelBooking) -- hold.amountKobo at that
// point is only what's STILL held, not the booking's real total, so the
// diff must be computed against booking.totalKobo (the actual current
// price) instead. When nothing's ever been released this is the exact
// same number hold.amountKobo already was, so the math is unchanged for
// every non-negotiated booking and for a negotiated one before its first
// release. A price decrease is capped so it never claws back money
// already paid to the vendor, and a new total that would fall below
// what's already been released is rejected outright rather than silently
// under-refunding.
async function reconcileBookingEditFinancials(booking, newTotalKobo, tx, { dryRun = false } = {}) {
  if (newTotalKobo === undefined) return null;
  const hold = await tx.escrowHold.findFirst({ where: { bookingId: booking.id, payeeRole: "VENDOR" } });
  if (!hold) return null;
  if (newTotalKobo < booking.amountReleasedKobo) {
    throw Object.assign(new Error(`The new total can't be less than the ₦${Math.round(booking.amountReleasedKobo / 100).toLocaleString()} already released to the vendor.`), { status: 400 });
  }
  const diff = newTotalKobo - booking.totalKobo;
  if (diff === 0) return null;
  if (diff > 0) {
    const w = await walletSvc.getOrCreateWallet(booking.customerId, tx);
    // Deliberately NOT gated on DEV_BYPASS_PAYMENTS, unlike debitWallet's
    // own internal check below -- this precheck's whole job is to show the
    // customer the real "insufficient funds -> add funds" flow. Bypassing
    // it here means the edit silently succeeds with no Add Funds screen at
    // all, which is the opposite of what's wanted: the screen should still
    // appear, and it's the payment picked FROM it (Bank Transfer, already
    // real-money-free via manualPayments' own dev-bypass auto-confirm; or
    // Wallet Balance, an honest retry against the real balance) that needs
    // to actually go through, not this initial detection being skipped.
    if (w.balanceKobo < diff) {
      // shortfallKobo is the raw price difference (new total minus old),
      // not netted against whatever free balance already happens to be in
      // the wallet from something unrelated -- "Amount to Add" is meant to
      // read as one plain number ("the booking went up by X, add X"), and
      // debitWallet below always pulls the full raw diff regardless of
      // what else is already in there, so that's the real number that
      // needs to exist in the wallet for this to go through either way.
      throw Object.assign(new Error("Your escrow wallet does not have enough to cover the new total. Add funds to continue."), { status: 400, shortfallKobo: diff });
    }
    if (!dryRun) {
      await walletSvc.debitWallet(booking.customerId, diff, "ESCROW_HOLD", { contextType: "BOOKING", contextId: booking.id, description: "Booking edit — added items" }, tx);
      await tx.escrowHold.update({ where: { id: hold.id }, data: { amountKobo: hold.amountKobo + diff } });
    }
  } else if (!dryRun) {
    await walletSvc.creditWallet(booking.customerId, -diff, "ESCROW_REFUND", { contextType: "BOOKING", contextId: booking.id, description: "Booking edit — removed items" }, tx);
    // Never decrease the hold by more than what's actually still held --
    // the newTotalKobo>=amountReleasedKobo guard above already ensures
    // this can't go negative, but capping explicitly keeps this correct
    // even if that invariant is ever loosened.
    const decreaseBy = Math.min(-diff, hold.amountKobo);
    await tx.escrowHold.update({ where: { id: hold.id }, data: { amountKobo: hold.amountKobo - decreaseBy } });
  }
  return diff;
}

// Lets the customer amend a booking's date/time/venue/guests/notes/package/
// items any time before the event's own scheduled date — only while it's
// still in a live pre-completion status. Before the vendor has committed
// (REQUESTED/PAID) an edit applies immediately, same as before, since
// there's no acceptance to be surprised out from under. Once the vendor
// has committed (CONFIRMED), an edit no longer applies immediately -- it's
// held in pendingEditSnapshot until the vendor explicitly accepts or
// declines it (see acceptEditedBooking/declineEditedBooking), so the
// vendor is never surprised by details changing after they've already
// committed. Once the job has actually started (Home Cook,
// vendorJobStartedAt) or the event's own date/time has passed, no further
// edits are allowed at all.
async function updateBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { vendor: { select: { id: true, userId: true } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Only the customer who made this booking can edit it." });
    if (!["REQUESTED", "PAID", "ACCEPTED", "CONFIRMED"].includes(booking.status)) {
      return res.status(400).json({ error: "This booking can no longer be edited." });
    }
    if (booking.vendorJobStartedAt) return res.status(400).json({ error: "The vendor has already started this job — it can no longer be edited." });
    if (booking.eventDate && new Date(booking.eventDate).getTime() <= Date.now()) {
      return res.status(400).json({ error: "This booking's date has already passed — it can no longer be edited." });
    }
    if (booking.pendingEditSnapshot) return res.status(409).json({ error: "You already have an edit awaiting the vendor's approval." });
    // Editing stays allowed even after part-payment has released -- only
    // cancellation locks at that point (see cancelBooking). Money safety
    // for a negotiated booking with releases already made is handled
    // inside reconcileBookingEditFinancials, which compares against the
    // booking's real totalKobo (not the hold's own, now-partial,
    // amountKobo) and rejects a new total below what's already released.

    const data = await buildBookingEditData(booking, req.body);

    if (booking.status !== "CONFIRMED") {
      // Vendor hasn't committed yet -- apply immediately, same as before.
      // A real hold may already exist (PAID/ACCEPTED) -- reconcile it for
      // real in the same transaction so a rejected top-up rolls back the
      // whole edit instead of partially applying it.
      let editDiffKobo = null;
      const updated = await prisma.$transaction(async (tx) => {
        editDiffKobo = await reconcileBookingEditFinancials(booking, data.totalKobo, tx);
        return tx.booking.update({ where: { id: booking.id }, data });
      });
      if (booking.vendor?.userId) {
        await notify(req.app.get("io"), booking.vendor.userId, "ORDER_UPDATE", "Booking details updated", `The customer updated booking #${booking.bookingNumber} — check the new details.`, { bookingId: booking.id });
      }
      // A removed item refunds the difference straight to the customer's
      // wallet inside reconcileBookingEditFinancials above -- never silent.
      if (editDiffKobo != null && editDiffKobo < 0) {
        await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Refund issued", `₦${Math.round(-editDiffKobo / 100).toLocaleString()} was refunded to your wallet for the items removed from booking #${booking.bookingNumber}.`, { bookingId: booking.id }).catch(() => {});
      }
      req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
      return res.json({ booking: updated });
    }

    // CONFIRMED: nothing is charged yet (the proposal might still be
    // declined) -- a dry-run precheck just tells the customer up front if
    // they can't actually afford this edit, so they see it right away
    // rather than only once the vendor eventually accepts it.
    await reconcileBookingEditFinancials(booking, data.totalKobo, prisma, { dryRun: true });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { pendingEditSnapshot: data, pendingEditRequestedAt: new Date() } });
    if (booking.vendor?.userId) {
      await notify(
        req.app.get("io"),
        booking.vendor.userId,
        "ORDER_UPDATE",
        "Customer edited their booking",
        `The customer proposed changes to booking #${booking.bookingNumber}. Accept the edited booking to continue, or decline it.`,
        { bookingId: booking.id }
      );
    }
    // Every other booking-mutating action here (accept/decline/accept-edit/
    // decline-edit/start-job/complete) emits booking:updated so an already-
    // open detail sheet on EITHER side re-renders in place -- this branch
    // is what actually creates a pending edit, and was missing it, which is
    // exactly why "customer edited" -> "job started" -> "waiting on
    // customer" looked seamless everywhere downstream but silently broke
    // at this first step.
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated, pending: true });
  } catch (err) {
    next(err);
  }
}

// Vendor's response to a pendingEditSnapshot (see updateBooking). Accept
// merges the proposed changes into the real booking; decline discards them
// and the booking is left exactly as it was.
async function acceptEditedBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (!booking.pendingEditSnapshot) return res.status(409).json({ error: "There is no edit awaiting your approval on this booking." });

    // Only actually charged/refunded now that the vendor has genuinely
    // committed to it -- the earlier dry-run at proposal time (updateBooking)
    // was just a preview, nothing was held back for it.
    let editDiffKobo = null;
    const updated = await prisma.$transaction(async (tx) => {
      editDiffKobo = await reconcileBookingEditFinancials(booking, booking.pendingEditSnapshot.totalKobo, tx);
      return tx.booking.update({
        where: { id: booking.id },
        data: { ...booking.pendingEditSnapshot, pendingEditSnapshot: null, pendingEditRequestedAt: null, wasEdited: true },
      });
    });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking edit accepted", `The vendor accepted your changes to booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    // The real charge/refund only happens HERE, at the vendor's acceptance
    // -- not at proposal time -- so this is the one real moment a refund
    // for removed items actually lands, and it needs its own notification.
    if (editDiffKobo != null && editDiffKobo < 0) {
      await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Refund issued", `₦${Math.round(-editDiffKobo / 100).toLocaleString()} was refunded to your wallet for the items removed from booking #${booking.bookingNumber}.`, { bookingId: booking.id }).catch(() => {});
    }
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

async function declineEditedBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (!booking.pendingEditSnapshot) return res.status(409).json({ error: "There is no edit awaiting your approval on this booking." });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { pendingEditSnapshot: null, pendingEditRequestedAt: null } });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking edit declined", `The vendor declined your proposed changes to booking #${booking.bookingNumber} — the booking is unchanged.`, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
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

// Every booking type now pays FIRST (REQUESTED -> payBooking -> PAID), so
// by the time a vendor can act on one it's already funded -- accept
// requires PAID, not REQUESTED, and moves straight to CONFIRMED. Event
// Planner used to skip payment entirely and go REQUESTED -> accept ->
// CONFIRMED directly; it now pays upfront exactly like Home Cook for a
// direct (non-proposal) booking. A proposal-created EP booking never
// reaches this function at all -- it auto-CONFIRMs the moment payment
// clears (orderFlow.confirmBookingPayment), since the vendor already
// committed to the price by submitting the proposal.
function requiredStatusForVendorDecision(type) {
  return "PAID";
}

async function acceptBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    const required = requiredStatusForVendorDecision(booking.type);
    if (booking.status !== required) {
      return res.status(409).json({ error: required === "PAID" && booking.status === "REQUESTED" ? "This booking hasn't been paid for yet." : `Booking is already ${booking.status.toLowerCase()}.` });
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
    const message = `Your ${bookingTypeLabel(booking.type)} booking was accepted and confirmed.`;
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking accepted", message, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// The customer already paid into escrow before the vendor ever saw this
// (see payBooking/confirmBookingPayment), for every booking type now --
// declining always has to refund it.
async function declineBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    const required = requiredStatusForVendorDecision(booking.type);
    if (booking.status !== required) {
      return res.status(409).json({ error: required === "PAID" && booking.status === "REQUESTED" ? "This booking hasn't been paid for yet." : `Booking is already ${booking.status.toLowerCase()}.` });
    }

    await escrow.refundAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: "Booking declined by vendor" });
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "DECLINED" } });
    const message = `Your ${bookingTypeLabel(booking.type)} booking request was declined -- your payment has been refunded to your wallet.`;
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking declined", message, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Payment happens immediately when the customer sends the request, before
// the vendor has decided -- not after acceptance. Matches Shop-For-Me's own
// pattern (pay upfront, before a shopper is even matched) and means the
// vendor never sees an unfunded request: by the time it reaches their
// dashboard (status PAID), the money is already held in escrow.
async function payBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: "This booking isn't awaiting payment." });

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
      await orderFlow.confirmBookingPayment(booking.id, null, req.app.get("io"));
      const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
      return res.json({ booking: updated, paid: true });
    }

    if (paymentMethod === "BANK_TRANSFER") {
      const { request, bankDetails, paid } = await manualPayments.createManualPaymentRequest(req.user.id, "BOOKING_PAYMENT", booking.id, booking.totalKobo, req.app.get("io"));
      if (paid) {
        const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
        return res.json({ booking: updated, paid: true });
      }
      return res.json({ paid: false, manual: true, requestId: request.id, reference: request.reference, bankDetails });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/USSD." });
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

// First of two vendor taps: "Job Started". Regular (non-catering) Home
// Cook: unchanged -- available the moment the booking is CONFIRMED. Before
// this, the customer sees "Waiting for Job to Start" and can still
// edit/cancel; after this, the customer sees "Waiting for Job to be
// Completed" and can no longer edit/cancel. Does not touch
// completion/escrow at all -- that's still gated on the second tap,
// completeBooking.
//
// Negotiated bookings (Event Planner always, Home Cook's Event Catering
// Package) additionally require the customer to have released at least
// the first payment -- "when they release payment to vendor before it
// will now continue from job started button." Engaging/chatting first is
// entirely optional (see engageBooking/endBookingConversation) -- the
// customer can release straight away with no conversation at all. Event
// Planner never had this stage before at all; it now shares it with Home
// Cook.
async function startBookingJob(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isVendor) return res.status(403).json({ error: "Only the vendor on this booking can start the job." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed (paid) before the job can start." });
    if (booking.vendorJobStartedAt) return res.status(409).json({ error: "You already started this job." });
    if (booking.pendingEditSnapshot) return res.status(409).json({ error: "Accept or decline the customer's pending edit before starting the job." });
    if (isNegotiatedBooking(booking) && booking.amountReleasedKobo <= 0) {
      return res.status(409).json({ error: "The customer must release the first payment before the job can start." });
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { vendorJobStartedAt: new Date() } });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Job started", `Your vendor has started the job for booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Either party's "Engage" tap (customer: "Engage Your Vendor", vendor:
// "Engage Customer") -- purely a chat/call unlock, never a payment gate,
// and per-side, not mutual: setting the caller's own engaged timestamp
// immediately reveals Chat/Call plus "End Booking Conversation" in THEIR
// OWN UI, regardless of whether the other side has engaged too. The other
// party never finds out from this tap alone -- only once the engaged
// party actually taps Chat or Call does a real request go out (the
// existing chat/call notification flow). Idempotent (re-tapping your own
// already-set engage is a harmless no-op). Scoped to before the first
// release (amountReleasedKobo===0) -- once the customer has released
// payment, the ordinary always-visible contact buttons take over instead.
async function engageBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor) return res.status(404).json({ error: "Booking not found." });
    if (!isNegotiatedBooking(booking)) return res.status(400).json({ error: "This booking type has no engage/conversation stage." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed first." });
    if (booking.pendingEditSnapshot) return res.status(409).json({ error: "Resolve the pending edit first." });
    if (booking.amountReleasedKobo > 0) return res.status(409).json({ error: "Payment has already been released for this booking." });

    const field = isCustomer ? "customerEngagedAt" : "vendorEngagedAt";
    if (booking[field]) return res.json({ booking });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { [field]: new Date() } });
    // No notification to the other party here on purpose -- engaging is
    // silent and reveals Chat/Call only to whoever just tapped it. The
    // other side only ever finds out once a real chat message or call
    // request actually goes out (the existing chat/call notification
    // flow), not from this tap alone.
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Either party can end the conversation -- unlike engageBooking (per-side,
// unilateral), this ends it for BOTH sides at once: clears both engaged
// timestamps, returning both the customer's and vendor's screens to their
// own Engage button (customer: Engage Your Vendor + Release Payment;
// vendor: Engage Customer) live via the booking:updated push below, no
// refresh needed. Either side can tap Engage again later, this isn't a
// one-time transition. negotiationEndedAt/negotiationEndedBy are still
// stamped as a harmless historical "a conversation happened" marker, but
// nothing reads them as a gate anymore -- Release Payment
// (releaseBookingPayment, below) has always been available regardless,
// engaged or not.
async function endBookingConversation(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor) return res.status(404).json({ error: "Booking not found." });
    if (!isNegotiatedBooking(booking)) return res.status(400).json({ error: "This booking type has no engage/conversation stage." });
    if (!booking.customerEngagedAt && !booking.vendorEngagedAt) return res.status(409).json({ error: "No conversation is currently active." });

    const endedBy = isCustomer ? "CUSTOMER" : "VENDOR";
    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { customerEngagedAt: null, vendorEngagedAt: null, negotiationEndedAt: new Date(), negotiationEndedBy: endedBy },
    });
    const notifyUserId = isCustomer ? booking.vendor.userId : booking.customerId;
    await notify(req.app.get("io"), notifyUserId, "ORDER_UPDATE", "Conversation ended", `The ${isCustomer ? "customer" : "vendor"} ended the conversation for booking #${booking.bookingNumber}.`, { bookingId: booking.id }).catch(() => {});
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Customer-only. Draws down the real HELD hold by exactly amountKobo --
// the hold is already funded in full (see orderFlow.confirmBookingPayment),
// this only ever moves money OUT of an already-existing hold, never
// charges anything new. Available any time the booking is CONFIRMED with
// something still held -- engaging/chatting the vendor first is entirely
// optional, never required (see engageBooking's own comment).
async function releaseBookingPayment(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (!isNegotiatedBooking(booking)) return res.status(400).json({ error: "This booking type has no negotiated release flow." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed first." });

    const hold = await prisma.escrowHold.findFirst({ where: { bookingId: booking.id, payeeRole: "VENDOR", status: "HELD" } });
    if (!hold) return res.status(409).json({ error: "There's nothing left in escrow for this booking." });

    const amountKobo = Math.round(Number(req.body.amountKobo) || 0);
    if (amountKobo <= 0) return res.status(400).json({ error: "Enter a valid amount to release." });
    if (amountKobo > hold.amountKobo) return res.status(400).json({ error: "That's more than what's still held in escrow." });

    await escrow.partialReleaseHold(hold.id, amountKobo, { description: "Booking payment released by customer" });
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { amountReleasedKobo: { increment: amountKobo } } });

    const vendor = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });
    if (vendor) await notify(req.app.get("io"), vendor.userId, "ORDER_UPDATE", "Payment released", `The customer released ₦${Math.round(amountKobo / 100).toLocaleString()} for booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Vendor-only. Only after the first release (i.e. "waiting for the
// job/event day" has genuinely begun) and only before Job Started --
// matches "As both are waiting for the day of the job or event, the
// vendor should have a button to ask for additional payment," explicitly
// not once the job itself has started. One in-flight request at a time.
async function requestAdditionalPayment(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    if (!isNegotiatedBooking(booking)) return res.status(400).json({ error: "This booking type has no negotiated release flow." });
    if (booking.amountReleasedKobo <= 0) {
      return res.status(409).json({ error: "The customer must release the first payment before you can request more." });
    }
    // Additional-payment requests belong to the "waiting for the job/event
    // day" window -- once Job Started is tapped, this is over; the only
    // thing left is Mark Job Complete, and whatever remains held pays out
    // there automatically.
    if (booking.vendorJobStartedAt) return res.status(409).json({ error: "You can no longer request additional payment once the job has started." });
    if (booking.pendingPaymentRequestKobo) return res.status(409).json({ error: "You already have a payment request awaiting the customer's response." });

    const hold = await prisma.escrowHold.findFirst({ where: { bookingId: booking.id, payeeRole: "VENDOR", status: "HELD" } });
    const amountKobo = Math.round(Number(req.body.amountKobo) || 0);
    if (amountKobo <= 0) return res.status(400).json({ error: "Enter a valid amount to request." });
    if (!hold || amountKobo > hold.amountKobo) return res.status(400).json({ error: "That's more than what's still held in escrow." });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { pendingPaymentRequestKobo: amountKobo, pendingPaymentRequestedAt: new Date() } });
    await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Vendor requesting additional payment", `The vendor is requesting ₦${Math.round(amountKobo / 100).toLocaleString()} for booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Customer-only response to a pending vendor request. Approve releases
// that exact amount (reuses the same partial-release path as
// releaseBookingPayment); decline just clears the request -- "the session
// returns to as it was before," per the user's own wording, no other side
// effect.
async function respondAdditionalPayment(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (!booking.pendingPaymentRequestKobo) return res.status(409).json({ error: "There is no payment request awaiting your response." });

    const approve = !!req.body.approve;
    const vendor = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });

    if (approve) {
      const hold = await prisma.escrowHold.findFirst({ where: { bookingId: booking.id, payeeRole: "VENDOR", status: "HELD" } });
      if (!hold || booking.pendingPaymentRequestKobo > hold.amountKobo) {
        return res.status(409).json({ error: "There's not enough left in escrow to release this request." });
      }
      await escrow.partialReleaseHold(hold.id, booking.pendingPaymentRequestKobo, { description: "Additional payment released by customer" });
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: { amountReleasedKobo: { increment: booking.pendingPaymentRequestKobo }, pendingPaymentRequestKobo: null, pendingPaymentRequestedAt: null },
      });
      if (vendor) {
        await notify(
          req.app.get("io"),
          vendor.userId,
          "ORDER_UPDATE",
          "Additional payment released",
          `The customer released your requested ₦${Math.round(booking.pendingPaymentRequestKobo / 100).toLocaleString()} for booking #${booking.bookingNumber}.`,
          { bookingId: booking.id }
        );
      }
      req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
      return res.json({ booking: updated });
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { pendingPaymentRequestKobo: null, pendingPaymentRequestedAt: null } });
    if (vendor) await notify(req.app.get("io"), vendor.userId, "ORDER_UPDATE", "Additional payment declined", `The customer declined your additional payment request for booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Vendor's "Mark Job Complete" tap -- two-sided completion, step 1, the
// same for every booking type now (Home Cook, Home Cook catering, and
// Event Planner). Does NOT complete the booking or release any escrow by
// itself, it just asks the customer to confirm (see confirmBookingCompletion
// for step 2), and requires Job Started to have already happened. Event
// Planner used to complete one-sided, immediately, right here -- it now
// goes through the exact same customer Yes/No + real dispute flow Home
// Cook always had (see confirmBookingCompletion's own comment on why "Yes"
// already correctly releases just the remaining balance for a
// partially-released negotiated booking with zero extra code).
// completeEventPlanningBooking below is kept for the one place that still
// needs a genuine one-sided completion: the 24h-past-event auto-complete
// sweep (bookingReminders.service.js), for a vendor who never taps this at
// all.
async function completeBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { customer: { select: { id: true } } } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isVendor) return res.status(403).json({ error: "Only the vendor on this booking can mark it complete." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed (paid) before it can be marked complete." });
    if (booking.vendorConfirmedCompleteAt) return res.status(409).json({ error: "You already marked this booking complete." });
    if (!booking.vendorJobStartedAt) return res.status(409).json({ error: "Start the job before marking it complete." });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { vendorConfirmedCompleteAt: new Date() } });
    await notify(
      req.app.get("io"),
      booking.customerId,
      "ORDER_UPDATE",
      "Confirm your booking is complete",
      `The vendor marked booking #${booking.bookingNumber} as complete. Please confirm so payment can be released.`,
      { bookingId: booking.id }
    );
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Shared by the real vendor-triggered completeBooking above AND the
// 24h-past-event auto-complete sweep (bookingReminders.service.js) -- same
// escrow release, same customer notification either way, so an EP vendor
// who simply never taps Mark Job Complete doesn't leave the booking stuck
// open forever.
//
// Does NOT call commission.service.js's addBookingCommission -- that was correct
// back when EP had no escrow at all (the weekly CommissionPeriod debt was
// EP's only commission-collection path), but EP bookings now pay into a
// real EscrowHold exactly like Home Cook (see orderFlow.confirmBookingPayment/
// the negotiated-release flow), and releaseAllHoldsForContext right above
// already deducts the platform's 10% cut in real time on every release --
// including this final one -- via creditPayeeWithCommission's
// PLATFORM_COMMISSION_RATES.VENDOR (escrow.service.js). Also calling
// addBookingCommission here would double-charge the vendor for the same
// booking, the exact bug commission.service.js's own comment already
// warns about for Home Cook.
async function completeEventPlanningBooking(booking, io, escrowDescription) {
  const now = new Date();
  await prisma.booking.update({ where: { id: booking.id }, data: { vendorConfirmedCompleteAt: now, customerConfirmedCompleteAt: now } });
  await escrow.releaseAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: escrowDescription });
  const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: now } });
  await notify(io, booking.customerId, "ORDER_UPDATE", "This Booking is completed", `Booking #${booking.bookingNumber} is complete. Thank you for using Handa!`, { bookingId: booking.id });
  closeSupportThreadForContext(booking.id);
  io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
  return updated;
}

// Two-sided completion, step 2: the customer's Yes/No response -- every
// booking type now (Home Cook, Home Cook catering, and Event Planner all
// go through completeBooking's same step 1 above).
// Yes -> booking COMPLETED, escrow releases (10% platform cut, same
// mechanism as Shop-For-Me's shopper/rider releases — see
// escrow.service.js's PLATFORM_COMMISSION_RATES).
// No -> booking stays CONFIRMED, a real dispute ticket is opened
// (context BOOKING) and every HELD hold on this booking is pulled out of
// the auto-release sweep via escrow.disputeHold() — the vendor is notified
// and can add their own side via POST /support/tickets/:id/respond; an
// admin resolving that ticket is what finally releases (or doesn't) the
// held funds.
async function confirmBookingCompletion(req, res, next) {
  try {
    const { completed, disputeCategory, disputeDescription } = req.body;
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "This booking isn't awaiting completion confirmation." });
    if (!booking.vendorConfirmedCompleteAt) return res.status(409).json({ error: "The vendor hasn't marked this booking complete yet." });
    if (booking.customerConfirmedCompleteAt) return res.status(409).json({ error: "You already responded to this booking's completion." });

    if (completed && booking.type === "CAKE") {
      const done = await completeCakeOrder(req.app.get("io"), booking.id);
      if (!done) return res.status(409).json({ error: "This order was already completed." });
      return res.json({ booking: await prisma.booking.findUnique({ where: { id: booking.id } }) });
    }
    if (completed) {
      await prisma.booking.update({ where: { id: booking.id }, data: { customerConfirmedCompleteAt: new Date() } });
      // Whatever's actually still HELD -- the full total for a plain
      // booking, or just the remaining balance for a negotiated one whose
      // hold amountKobo was already shrunk by earlier partial releases
      // (see escrow.service.js's partialReleaseHold comment). Reporting
      // the real released amount here, not booking.totalKobo, so a
      // partially-released EP/Cook-catering booking's notification says
      // what actually just moved, not the full original total.
      const released = await escrow.releaseAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: "Booking completion confirmed by customer" });
      const releasedKobo = released.reduce((sum, h) => sum + h.amountKobo, 0);
      const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      const vendor = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });
      if (vendor) {
        await notify(
          req.app.get("io"),
          vendor.userId,
          "ORDER_UPDATE",
          "This Booking is completed",
          `Booking #${booking.bookingNumber} is complete: Escrow has released your payment.<br>₦${Math.round(releasedKobo / 100).toLocaleString()}.`,
          { bookingId: booking.id }
        );
      }
      closeSupportThreadForContext(booking.id);
      req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
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
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking, ticket });
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isCustomer = booking.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && booking.vendorId === req.user.vendorProfile.id;
    if (!isCustomer && !isVendor) return res.status(404).json({ error: "Booking not found." });
    if (["COMPLETED", "CANCELLED"].includes(booking.status)) return res.status(409).json({ error: `Booking is already ${booking.status.toLowerCase()}.` });
    // CAKE reuses vendorJobStartedAt as a side effect of markCakeReady (see
    // its own comment) -- it's never a real "vendor is now irreversibly
    // mid-job" signal for cake the way it is for Home Cook/EP/Catering, so
    // this guard must not apply to it. A cake order can still be cancelled
    // any time before the rider actually hands it to the customer -- once
    // deliveredAt is set the booking auto-completes anyway and the
    // COMPLETED check above already covers it.
    if (booking.type !== "CAKE" && booking.vendorJobStartedAt) {
      return res.status(400).json({ error: "The vendor has already started this job — it can no longer be cancelled." });
    }
    if (booking.type === "CAKE" && booking.deliveredAt) {
      return res.status(400).json({ error: "This cake has already been delivered — it can no longer be cancelled." });
    }
    // Negotiated bookings (Event Planner, Home Cook catering): once any
    // part-payment has been released to the vendor, cancellation is over --
    // matches the edit lock right above updateBooking's own guard. This is
    // a strict superset of the vendorJobStartedAt check above for these
    // booking types, since startBookingJob itself requires
    // amountReleasedKobo > 0 before the job can start -- it also catches
    // the narrower window between the first release and Job Started, which
    // vendorJobStartedAt alone wouldn't yet block.
    if (isNegotiatedBooking(booking) && booking.amountReleasedKobo > 0) {
      return res.status(400).json({ error: "This booking can no longer be cancelled once payment has been released to the vendor." });
    }

    // A reason is always required now -- both so the other side/admin can
    // see WHY, not just that it happened, and so the admin panel's booking
    // detail has something real to show instead of nothing at all.
    const reason = (req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "A cancellation reason is required." });

    // PAID: the customer paid at request time and the vendor hasn't decided
    // yet. CONFIRMED: vendor already accepted (every booking type pays
    // upfront now, Event Planner included). Either way there's real money
    // held that needs refunding -- refundAllHoldsForContext correctly
    // refunds only what's STILL held, which for a negotiated booking with
    // one or more partial releases already made is the true remainder, not
    // the original total (partialReleaseHold decrements the hold in place,
    // see escrow.service.js) -- already-released amounts are never clawed
    // back from the vendor.
    let refundedKobo = 0;
    if (["PAID", "CONFIRMED"].includes(booking.status)) {
      const refunded = await escrow.refundAllHoldsForContext({ contextType: "BOOKING", bookingId: booking.id }, { description: `Booking cancelled by ${isCustomer ? "customer" : "vendor"}` });
      refundedKobo = refunded.reduce((s, h) => s + h.amountKobo, 0);
    }
    const cancelledBy = isCustomer ? "CUSTOMER" : "VENDOR";
    const updated = await prisma.booking.update({
      where: { id: booking.id },
      // Clears any unresolved pendingEditSnapshot/pendingPaymentRequestKobo
      // along with the cancellation -- without this, a booking cancelled
      // while an edit or a vendor payment request was still pending kept
      // showing live Accept/Decline (or Release/Decline) buttons forever,
      // since every render of those blocks only ever checks whether the
      // field is set, not whether the booking is still actually alive.
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelledBy,
        pendingEditSnapshot: null,
        pendingEditRequestedAt: null,
        pendingPaymentRequestKobo: null,
        pendingPaymentRequestedAt: null,
      },
    });
    closeSupportThreadForContext(booking.id);
    // Notify whichever side didn't do the cancelling.
    // An unpaid (REQUESTED) order was never shown to the vendor, so there's
    // nothing to tell them when the customer abandons it.
    if (isCustomer && booking.vendor && booking.status !== "REQUESTED") {
      await notify(req.app.get("io"), booking.vendor.userId, "ORDER_UPDATE", "Booking cancelled", `The customer cancelled booking #${booking.bookingNumber}. Reason: ${reason}`, { bookingId: booking.id });
    } else if (isVendor) {
      await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Booking cancelled", `The vendor cancelled booking #${booking.bookingNumber}. Reason: ${reason}`, { bookingId: booking.id });
    }
    // The refund is credited instantly above -- always tell the customer
    // exactly how much came back, whoever cancelled.
    if (refundedKobo > 0) {
      await notify(req.app.get("io"), booking.customerId, "ORDER_UPDATE", "Refund issued", `₦${Math.round(refundedKobo / 100).toLocaleString()} for #${booking.bookingNumber} has been refunded to your wallet.`, { bookingId: booking.id }).catch(() => {});
    }
    // A cake rider already on the job must hear it's off, too.
    if (booking.riderId) {
      const rp = await prisma.riderProfile.findUnique({ where: { id: booking.riderId }, select: { userId: true } });
      if (rp) await notify(req.app.get("io"), rp.userId, "ORDER_UPDATE", "Delivery cancelled", `Order #${booking.bookingNumber} was cancelled -- no pickup or delivery needed.`, { bookingId: booking.id }).catch(() => {});
    }
    req.app.get("io")?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// ── CAKE rider delivery ────────────────────────────────────────────────
// A baked cake has to actually be picked up from the vendor and delivered
// to the customer -- new territory for Booking (every other type is
// vendor-comes-to-you or pickup-yourself). Deliberately NOT a new
// BookingStatus enum value or a ShopSession-style separate status field:
// booking.status stays CONFIRMED for the whole delivery, exactly like a
// negotiated booking's status stays CONFIRMED through its own multi-stage
// release -- these timestamp fields (see schema.prisma's Booking model)
// are the real sub-state machine, read together by the frontend to derive
// which delivery phase is showing. Mirrors ShopSession's own
// shopper->rider->customer handoff (findRider/acceptDelivery/markDelivered
// in shopSessions.controller.js) as closely as possible rather than
// inventing a parallel pattern.
function assertCakeBooking(booking) {
  if (booking.type !== "CAKE") {
    const err = new Error("This action only applies to cake bookings.");
    err.status = 400;
    throw err;
  }
}

// Vendor's "the cake is ready" tap -- only meaningful once paid (CONFIRMED).
// Doubles as vendorJobStartedAt (baking IS the job, for a cake) so the
// existing two-sided completion flow (completeBooking/confirmBookingCompletion)
// needs no changes: confirmDelivery below sets vendorConfirmedCompleteAt the
// same way completeBooking normally would, and the customer's existing
// Yes/No confirm screen picks it up completely unchanged.
async function markCakeReady(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    assertCakeBooking(booking);
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "Booking must be confirmed (paid) before it can be marked ready." });
    if (booking.vendorReadyAt) return res.status(409).json({ error: "This cake was already marked ready." });

    // Marking ready no longer dispatches on its own -- the baker lands on
    // their live delivery screen and taps "Search for a Rider" as a separate
    // deliberate step (searchCakeRider below), same as a shopper's own
    // find-rider after packaging.
    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        vendorReadyAt: new Date(),
        vendorJobStartedAt: booking.vendorJobStartedAt || new Date(),
        pickupCode: generateOtpCode(),
        deliveryCode: generateOtpCode(),
      },
    });
    const io = req.app.get("io");
    await notify(io, booking.customerId, "ORDER_UPDATE", "Your cake is ready", `Order #${booking.bookingNumber} is ready -- your baker is about to find a rider to deliver it.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// The baker's "Search for a Rider" tap -- the one thing that makes a ready
// cake visible to online riders (listAvailableCakeDeliveries below) and
// pings them live, mirroring shopSessions.controller.js's findRider.
async function searchCakeRider(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertVendorOwnsBooking(req, booking);
    assertCakeBooking(booking);
    if (booking.status !== "CONFIRMED") return res.status(409).json({ error: "This order isn't active." });
    if (!booking.vendorReadyAt) return res.status(409).json({ error: "Mark the cake ready first." });
    if (booking.riderId) return res.status(409).json({ error: "A rider has already accepted this delivery." });

    const updated = booking.riderSearchStartedAt
      ? booking
      : await prisma.booking.update({ where: { id: booking.id }, data: { riderSearchStartedAt: new Date() } });
    const io = req.app.get("io");
    io?.to("dispatch:riders").emit("dispatch:new-cake-delivery", { bookingId: booking.id });
    await notify(io, booking.customerId, "ORDER_UPDATE", "Finding a rider", `Your baker is searching for a rider to deliver order #${booking.bookingNumber}.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Pull, not push -- same as ShopSession's listSessions?as=available (the
// dispatch:riders socket event above is just a "go check the list" nudge).
// Nearest-first: each delivery carries the same honest state/LGA-centroid
// distance/ETA estimate the Shop-For-Me rider list already shows, and the
// list is sorted by it so the closest pickups sit at the top.
async function listAvailableCakeDeliveries(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "Only rider accounts can view available deliveries." });
    const bookings = await prisma.booking.findMany({
      where: { type: "CAKE", vendorReadyAt: { not: null }, riderSearchStartedAt: { not: null }, riderId: null, status: "CONFIRMED" },
      include: { vendor: { include: { user: { select: { name: true, address: true, state: true, lga: true } } } } },
      orderBy: { riderSearchStartedAt: "asc" },
    });
    const riderUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { state: true, lga: true } });
    const out = bookings.map(stripRiderCodes).map((b) => {
      const vu = b.vendor && b.vendor.user;
      if (vu && riderUser && riderUser.state && vu.state) {
        const km = distanceFee.computeDistanceKm({ state: riderUser.state, lga: riderUser.lga }, { state: vu.state, lga: vu.lga });
        b.distanceToVendorKm = Math.round(km * 10) / 10;
        b.etaToVendorMinutes = Math.max(3, Math.round((km / 25) * 60));
      }
      return b;
    });
    out.sort((a, b) => (a.distanceToVendorKm ?? 9999) - (b.distanceToVendorKm ?? 9999));
    res.json({ bookings: out });
  } catch (err) {
    next(err);
  }
}

// First-to-accept claim, same atomic compare-and-swap pattern as
// ShopSession's acceptDelivery (updateMany with riderId still null in the
// WHERE clause, so two riders racing on the same job can't both win).
async function acceptCakeDelivery(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "Only rider accounts can accept deliveries." });
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertCakeBooking(booking);
    if (!booking.vendorReadyAt || !booking.riderSearchStartedAt || booking.riderId || booking.status !== "CONFIRMED") {
      return res.status(409).json({ error: "This delivery is no longer available." });
    }

    const result = await prisma.booking.updateMany({
      where: { id: booking.id, riderId: null },
      data: { riderId: req.user.riderProfile.id, riderAcceptedAt: new Date() },
    });
    if (result.count === 0) return res.status(409).json({ error: "Another rider already accepted this delivery." });

    // The customer already paid the rider fee into escrow at checkout (see
    // confirmBookingPayment's unassigned RIDER hold) -- the accepting rider
    // just becomes its payee. Nothing is ever created from thin air here.
    await prisma.escrowHold.updateMany({
      where: { contextType: "BOOKING", bookingId: booking.id, payeeRole: "RIDER", payeeId: null, status: "HELD" },
      data: { payeeId: req.user.id },
    });
    const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
    const io = req.app.get("io");
    await notify(io, booking.customerId, "ORDER_UPDATE", "A rider is on the way", `A rider accepted your cake delivery for booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Rider assigned", `A rider is coming to pick up booking #${booking.bookingNumber}.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

function assertRiderOnBooking(req, booking) {
  if (!req.user.riderProfile || booking.riderId !== req.user.riderProfile.id) {
    const err = new Error("Booking not found.");
    err.status = 404;
    throw err;
  }
}

async function riderArrivedAtCakeVendor(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertRiderOnBooking(req, booking);
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { riderArrivedVendorAt: new Date() } });
    const io = req.app.get("io");
    await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Rider has arrived", `The rider is at your location for order #${booking.bookingNumber} -- give them the pickup code.`, { bookingId: booking.id });
    await notify(io, booking.customerId, "ORDER_UPDATE", "Rider at the baker", `The rider has arrived at the baker to pick up order #${booking.bookingNumber}.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Rider enters the pickup code the vendor can see on their own dashboard --
// same lightweight in-person proof as ShopSession's handover codes.
async function confirmCakePickup(req, res, next) {
  try {
    const { code } = req.body;
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertRiderOnBooking(req, booking);
    if (!code || String(code) !== booking.pickupCode) return res.status(400).json({ error: "Incorrect pickup code." });
    if (booking.vendorHandoverConfirmedAt) return res.status(409).json({ error: "Pickup already confirmed." });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { vendorHandoverConfirmedAt: new Date() } });
    const io = req.app.get("io");
    await notify(io, booking.customerId, "ORDER_UPDATE", "Your cake is on the way", `Order #${booking.bookingNumber} has been picked up and is out for delivery.`, { bookingId: booking.id });
    await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Cake picked up", `The rider picked up order #${booking.bookingNumber} and is heading to the customer.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

async function riderArrivedAtCakeCustomer(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertRiderOnBooking(req, booking);
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { riderArrivedCustomerAt: new Date() } });
    const io = req.app.get("io");
    await notify(io, booking.customerId, "ORDER_UPDATE", "Your rider has arrived", `The rider is at your address with order #${booking.bookingNumber} -- give them your delivery code.`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Rider enters the delivery code the CUSTOMER can see. This is the rider's
// own job done -- their escrow hold releases right here, independent of
// whether the customer is happy with the cake itself (that's the vendor's
// hold, released separately by the customer's own existing
// confirmBookingCompletion tap, unchanged -- vendorConfirmedCompleteAt set
// below is exactly what that screen already waits for).
async function confirmCakeDelivery(req, res, next) {
  try {
    const { code } = req.body;
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    assertRiderOnBooking(req, booking);
    if (!code || String(code) !== booking.deliveryCode) return res.status(400).json({ error: "Incorrect delivery code." });
    if (booking.deliveredAt) return res.status(409).json({ error: "Delivery already confirmed." });

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { deliveredAt: new Date(), vendorConfirmedCompleteAt: booking.vendorConfirmedCompleteAt || new Date() },
    });
    await prisma.riderProfile.update({ where: { id: req.user.riderProfile.id }, data: { deliveries: { increment: 1 } } });

    // Same ending as Shop-For-Me: nothing is released yet. The customer has
    // CAKE_RELEASE_WINDOW_MS to tap "Complete Order", after which the baker's
    // and rider's payments release together automatically (timer below, with
    // finalizeDueCakeDeliveries' sweep as the restart-safe backup).
    const io = req.app.get("io");
    scheduleCakeAutoRelease(io, booking.id);
    await notify(io, booking.customerId, "ORDER_UPDATE", "Your cake has been delivered", `Order #${booking.bookingNumber} was delivered. Complete the order to release payment — it releases automatically in 90 seconds.`, { bookingId: booking.id });
    const vendorForNotify = await prisma.vendorProfile.findUnique({ where: { id: booking.vendorId }, select: { userId: true } });
    if (vendorForNotify) await notify(io, vendorForNotify.userId, "ORDER_UPDATE", "Cake delivered", `The rider delivered order #${booking.bookingNumber}. Payment releases once the customer completes the order (or automatically in 90 seconds).`, { bookingId: booking.id });
    io?.to([`booking:${booking.id}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId: booking.id });
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

const CAKE_RELEASE_WINDOW_MS = 90 * 1000;

// Completes a delivered CAKE order: releases every still-HELD hold (baker +
// rider) at once and tells both what they were paid. Atomic claim on
// customerConfirmedCompleteAt so the customer's own tap, the 90s timer and
// the sweep can never double-release.
async function completeCakeOrder(io, bookingId, { auto = false } = {}) {
  // A reported problem freezes the money for Handa to resolve -- never
  // auto-complete over it.
  const disputed = await prisma.escrowHold.count({ where: { contextType: "BOOKING", bookingId, status: "DISPUTED" } });
  if (disputed > 0) return null;
  const now = new Date();
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, type: "CAKE", status: "CONFIRMED", deliveredAt: { not: null }, customerConfirmedCompleteAt: null },
    data: { customerConfirmedCompleteAt: now, status: "COMPLETED", completedAt: now },
  });
  if (count === 0) return null;
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { vendor: { select: { userId: true } }, rider: { select: { userId: true } } } });
  const released = await escrow.releaseAllHoldsForContext(
    { contextType: "BOOKING", bookingId },
    { description: auto ? "Cake order auto-released after delivery" : "Cake order completed by customer" }
  );
  const sumFor = (role) => released.filter((h) => h.payeeRole === role).reduce((s, h) => s + h.amountKobo, 0);
  // What actually lands in the wallet: the released amount minus Handa's
  // cut (escrow.service creditPayeeWithCommission) -- never the gross.
  const netFor = (role) => {
    const gross = sumFor(role);
    return gross - Math.round(gross * (escrow.PLATFORM_COMMISSION_RATES[role] || 0));
  };
  const feeFor = (role) => sumFor(role) - netFor(role);
  const naira = (k) => `₦${Math.round(k / 100).toLocaleString()}`;
  if (booking.vendor) {
    await notify(io, booking.vendor.userId, "ORDER_UPDATE", "Payment released", `Order #${booking.bookingNumber} is complete — ${naira(netFor("VENDOR"))} has been paid to your wallet (${naira(sumFor("VENDOR"))} order, less ${naira(feeFor("VENDOR"))} Handa fee).`, { bookingId }).catch(() => {});
  }
  if (booking.rider) {
    await notify(io, booking.rider.userId, "ORDER_UPDATE", "Payment released", `${naira(netFor("RIDER"))} for delivering order #${booking.bookingNumber} has been paid to your wallet (${naira(sumFor("RIDER"))} fee, less ${naira(feeFor("RIDER"))} Handa fee).`, { bookingId }).catch(() => {});
  }
  if (auto) {
    await notify(io, booking.customerId, "ORDER_UPDATE", "Order completed", `Payment for order #${booking.bookingNumber} was released automatically. Rate your baker and rider!`, { bookingId }).catch(() => {});
  }
  closeSupportThreadForContext(bookingId);
  io?.to([`booking:${bookingId}`, `vendor:${booking.vendorId}`, `user:${booking.customerId}`]).emit("booking:updated", { bookingId });
  return booking;
}

function scheduleCakeAutoRelease(io, bookingId, delayMs = CAKE_RELEASE_WINDOW_MS) {
  setTimeout(() => {
    completeCakeOrder(io, bookingId, { auto: true }).catch((err) => console.error("[cake] auto-release failed:", err));
  }, Math.max(0, delayMs));
}

// Restart-safe backup for the in-memory timer above.
async function finalizeDueCakeDeliveries(io) {
  const due = await prisma.booking.findMany({
    where: { type: "CAKE", status: "CONFIRMED", customerConfirmedCompleteAt: null, deliveredAt: { lte: new Date(Date.now() - CAKE_RELEASE_WINDOW_MS) } },
    select: { id: true },
  });
  for (const b of due) await completeCakeOrder(io, b.id, { auto: true });
  return due.length;
}

module.exports = {
  completeCakeOrder,
  estimateCakeRiderFee,
  getCakeDeliveryFee,
  finalizeDueCakeDeliveries,
  createBooking,
  listBookings,
  getBooking,
  updateBooking,
  acceptEditedBooking,
  declineEditedBooking,
  acceptBooking,
  declineBooking,
  payBooking,
  startBookingJob,
  engageBooking,
  endBookingConversation,
  releaseBookingPayment,
  requestAdditionalPayment,
  respondAdditionalPayment,
  completeBooking,
  completeEventPlanningBooking,
  confirmBookingCompletion,
  cancelBooking,
  markCakeReady,
  searchCakeRider,
  listAvailableCakeDeliveries,
  acceptCakeDelivery,
  riderArrivedAtCakeVendor,
  confirmCakePickup,
  riderArrivedAtCakeCustomer,
  confirmCakeDelivery,
};
