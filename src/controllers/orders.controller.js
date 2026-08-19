const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const walletSvc = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const orderFlow = require("../services/orderFlow.service");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");
const { generateOtpCode } = require("../utils/otp");

const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_ORDER_FEE_PERCENT || 5);

// Orders are for catalog checkout (restaurant dishes, raw-food items,
// cakes) — priced from MenuItem rows the vendor owns, never trusting a
// client-supplied price. Catering/home-cook/event-planning go through
// Booking instead (see bookings.controller), since those are custom
// quoted requests, not a cart of fixed-price items.
async function createOrder(req, res, next) {
  try {
    const { vendorId, type, items, paymentMethod, deliveryAddress, deliveryLat, deliveryLng, note, bankCode } = req.body;
    if (!vendorId || !type || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "vendorId, type, and at least one item are required." });
    }
    if (!deliveryAddress) return res.status(400).json({ error: "deliveryAddress is required." });
    if (!["RAW_FOOD", "CAKE"].includes(type)) return res.status(400).json({ error: "Invalid order type." });

    const vendor = await prisma.vendorProfile.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });

    const menuItemIds = items.map((i) => i.menuItemId);
    const menuItems = await prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, vendorId } });
    if (menuItems.length !== new Set(menuItemIds).size) {
      return res.status(400).json({ error: "One or more items do not belong to this vendor." });
    }

    let subtotalKobo = 0;
    const orderItemsData = items.map((reqItem) => {
      const menuItem = menuItems.find((m) => m.id === reqItem.menuItemId);
      if (!menuItem.inStock) throw Object.assign(new Error(`${menuItem.name} is currently out of stock.`), { status: 409 });
      const qty = Math.max(1, parseInt(reqItem.qty) || 1);
      subtotalKobo += menuItem.priceKobo * qty;
      return { menuItemId: menuItem.id, name: menuItem.name, priceKobo: menuItem.priceKobo, qty, note: reqItem.note || null };
    });

    if (vendor.minOrderKobo && subtotalKobo < vendor.minOrderKobo) {
      return res.status(400).json({ error: `Minimum order for this vendor is ₦${vendor.minOrderKobo / 100}.` });
    }

    const deliveryFeeKobo = vendor.baseDeliveryFeeKobo;
    const platformFeeKobo = Math.round((subtotalKobo * PLATFORM_FEE_PERCENT) / 100);
    const totalKobo = subtotalKobo + deliveryFeeKobo + platformFeeKobo;

    const order = await prisma.order.create({
      data: {
        orderNumber: generateReference("ORD"),
        type,
        paymentMethod,
        customerId: req.user.id,
        vendorId,
        subtotalKobo,
        deliveryFeeKobo,
        platformFeeKobo,
        totalKobo,
        deliveryAddress,
        deliveryLat,
        deliveryLng,
        note,
        pickupCode: generateOtpCode(),
        deliveryCode: generateOtpCode(),
        items: { create: orderItemsData },
      },
      include: { items: true },
    });

    if (paymentMethod === "WALLET") {
      await prisma.$transaction(async (tx) => {
        await walletSvc.debitWallet(req.user.id, totalKobo, "ESCROW_HOLD", { contextType: "ORDER", contextId: order.id, description: "Order payment" }, tx);
      });
      await orderFlow.confirmOrderPayment(order.id);
      req.app.get("io")?.to(`vendor:${vendorId}`).emit("order:new", { orderId: order.id });
      return res.status(201).json({ order, paid: true });
    }

    if (paymentMethod === "CASH_ON_DELIVERY") {
      req.app.get("io")?.to(`vendor:${vendorId}`).emit("order:new", { orderId: order.id });
      return res.status(201).json({ order, paid: false, codConfirmedAtDelivery: true });
    }

    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before paying by card/transfer/USSD." });
    const reference = generateReference("ORD");
    const payment = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: totalKobo,
      reference,
      metadata: { purpose: "ORDER_PAYMENT", orderId: order.id },
    });
    res.status(201).json({ order, paid: false, authorizationUrl: payment.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// ?as=vendor / ?as=rider switches perspective for a user who holds more
// than one role's profile-bearing data; default is "customer's own orders".
async function listOrders(req, res, next) {
  try {
    const { as, status } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, parseInt(req.query.pageSize) || 20);

    let where = { customerId: req.user.id };
    if (as === "vendor") {
      if (!req.user.vendorProfile) return res.status(403).json({ error: "No vendor profile found." });
      where = { vendorId: req.user.vendorProfile.id };
    } else if (as === "rider") {
      if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
      where = { riderId: req.user.riderProfile.id };
    } else if (as === "available") {
      // Orders ready for pickup with no rider yet — matches the
      // "dispatch:new-delivery" broadcast riders get when a vendor calls
      // POST /:id/ready. Mirrors shopSessions.controller.js's as=available.
      if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
      where = { status: "READY_FOR_PICKUP", riderId: null };
    }
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          customer: { select: { name: true, phone: true } },
          vendor: { include: { user: { select: { name: true, phone: true } } } },
          rider: { include: { user: { select: { name: true, phone: true } } } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    // Same rule as getOrder: a rider viewing their own delivery list must
    // never see the handover codes on their own screen.
    if (as === "rider" || as === "available") {
      orders.forEach((o) => { o.pickupCode = undefined; o.deliveryCode = undefined; });
    }

    res.json({ orders, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

async function getOrder(req, res, next) {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        vendor: { include: { user: { select: { name: true, phone: true, address: true } } } },
        rider: { include: { user: { select: { name: true, phone: true } } } },
        ratings: true,
      },
    });
    if (!order) return res.status(404).json({ error: "Order not found." });

    const isCustomer = order.customerId === req.user.id;
    const isVendor = req.user.vendorProfile && order.vendorId === req.user.vendorProfile.id;
    const isRider = req.user.riderProfile && order.riderId === req.user.riderProfile.id;
    if (!isCustomer && !isVendor && !isRider && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "You do not have access to this order." });
    }
    // The rider must be told these codes verbally/in-app by the vendor
    // and customer — never read them off their own screen.
    if (isRider && !isCustomer && !isVendor) {
      order.pickupCode = undefined;
      order.deliveryCode = undefined;
    }

    res.json({ order });
  } catch (err) {
    next(err);
  }
}

function assertVendorOwnsOrder(req, order) {
  if (!req.user.vendorProfile || order.vendorId !== req.user.vendorProfile.id) {
    const err = new Error("Order not found.");
    err.status = 404;
    throw err;
  }
}

async function acceptOrder(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Order not found." });
    assertVendorOwnsOrder(req, order);
    if (order.status !== "PENDING") return res.status(409).json({ error: `Order is already ${order.status.toLowerCase()}.` });

    if (order.paymentMethod !== "CASH_ON_DELIVERY") {
      const hold = await prisma.escrowHold.findFirst({ where: { orderId: order.id, payeeRole: "VENDOR", status: "HELD" } });
      if (!hold) return res.status(402).json({ error: "Payment has not been completed for this order yet." });
    }

    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
    const io = req.app.get("io");
    io?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "ACCEPTED" });
    await notify(io, order.customerId, "ORDER_UPDATE", "Order accepted", `Your order ${order.orderNumber} was accepted and is being prepared.`, { orderId: order.id });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

async function declineOrder(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Order not found." });
    assertVendorOwnsOrder(req, order);
    if (order.status !== "PENDING") return res.status(409).json({ error: `Order is already ${order.status.toLowerCase()}.` });

    await escrow.refundAllHoldsForContext({ contextType: "ORDER", orderId: order.id }, { description: "Vendor declined the order" });
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: req.body.reason || "Declined by vendor" },
    });
    const io = req.app.get("io");
    io?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "CANCELLED" });
    await notify(io, order.customerId, "ORDER_UPDATE", "Order declined", `${order.orderNumber} was declined by the vendor and has been refunded to your wallet.`, { orderId: order.id });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

async function markReady(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Order not found." });
    assertVendorOwnsOrder(req, order);
    if (!["ACCEPTED", "PREPARING"].includes(order.status)) return res.status(409).json({ error: "Order is not being prepared." });

    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "READY_FOR_PICKUP", readyAt: new Date() } });
    const io = req.app.get("io");
    io?.to("dispatch:riders").emit("dispatch:new-delivery", { orderId: order.id, vendorId: order.vendorId });
    io?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "READY_FOR_PICKUP" });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

// COD orders never fund a rider escrow hold (there's no customer
// prepayment to hold) — the rider is paid straight out at delivery
// confirmation instead (see confirmOrder).
async function acceptDelivery(req, res, next) {
  try {
    if (!req.user.riderProfile) return res.status(403).json({ error: "No rider profile found." });
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.status !== "READY_FOR_PICKUP") return res.status(409).json({ error: "Order is not ready for pickup yet." });
    if (order.riderId) return res.status(409).json({ error: "Another rider has already accepted this delivery." });

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: "RIDER_ASSIGNED", riderId: req.user.riderProfile.id },
      include: {
        items: true,
        customer: { select: { name: true, phone: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
      },
    });

    if (order.paymentMethod !== "CASH_ON_DELIVERY" && order.deliveryFeeKobo > 0) {
      await escrow.createHold({
        contextType: "ORDER",
        orderId: order.id,
        payerId: order.customerId,
        payeeId: req.user.id,
        payeeRole: "RIDER",
        amountKobo: order.deliveryFeeKobo,
      });
    }

    req.app.get("io")?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "RIDER_ASSIGNED", riderId: req.user.riderProfile.id });
    // Never leak the handover codes to the rider's own screen — same rule
    // as getOrder/listOrders.
    updated.pickupCode = undefined;
    updated.deliveryCode = undefined;
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

async function markPickedUp(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || !req.user.riderProfile || order.riderId !== req.user.riderProfile.id) return res.status(404).json({ error: "Order not found." });
    if (order.status !== "RIDER_ASSIGNED") return res.status(409).json({ error: "Order has not been assigned to you yet." });
    if (order.pickupCode && req.body.code !== order.pickupCode) {
      return res.status(400).json({ error: "Incorrect pickup code. Ask the vendor for the code on their screen." });
    }

    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "PICKED_UP", pickedUpAt: new Date() } });
    req.app.get("io")?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "PICKED_UP" });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

async function markDelivered(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || !req.user.riderProfile || order.riderId !== req.user.riderProfile.id) return res.status(404).json({ error: "Order not found." });
    if (order.status !== "PICKED_UP") return res.status(409).json({ error: "Order has not been picked up yet." });
    if (order.deliveryCode && req.body.code !== order.deliveryCode) {
      return res.status(400).json({ error: "Incorrect delivery code. Ask the customer for their code." });
    }

    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });

    if (order.paymentMethod === "CASH_ON_DELIVERY") {
      await walletSvc.creditWallet(req.user.id, order.deliveryFeeKobo, "PAYOUT", { contextType: "ORDER", contextId: order.id, description: "Cash-on-delivery rider fee" });
    }

    const io = req.app.get("io");
    io?.to(`order:${order.id}`).emit("order:status", { orderId: order.id, status: "DELIVERED" });
    await notify(io, order.customerId, "ORDER_UPDATE", "Order delivered", `${order.orderNumber} has arrived. Confirm delivery to release payment.`, { orderId: order.id });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

// The customer's explicit "Confirm Delivery" tap — releases every HELD
// hold on this order (vendor's subtotal, rider's delivery fee) instead of
// waiting for the escrow.service auto-release sweep.
async function confirmOrder(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.customerId !== req.user.id) return res.status(404).json({ error: "Order not found." });
    if (order.status !== "DELIVERED") return res.status(409).json({ error: "Order has not been marked delivered yet." });

    await escrow.releaseAllHoldsForContext({ contextType: "ORDER", orderId: order.id }, { description: "Customer confirmed delivery" });
    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

async function cancelOrder(req, res, next) {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.customerId !== req.user.id) return res.status(404).json({ error: "Order not found." });
    if (order.status !== "PENDING") return res.status(409).json({ error: "Only orders awaiting vendor acceptance can be cancelled." });

    await escrow.refundAllHoldsForContext({ contextType: "ORDER", orderId: order.id }, { description: "Cancelled by customer" });
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: req.body.reason || "Cancelled by customer" },
    });
    res.json({ order: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createOrder,
  listOrders,
  getOrder,
  acceptOrder,
  declineOrder,
  markReady,
  acceptDelivery,
  markPickedUp,
  markDelivered,
  confirmOrder,
  cancelOrder,
};
