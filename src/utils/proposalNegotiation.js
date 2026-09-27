const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

// Price negotiation on a request's proposal (Event / Catering / Cake), the
// same back-and-forth as inDrive: the customer sends their own price, the
// vendor accepts it or sends a new price, and so on until one side accepts.
//   proposal.priceKobo         the vendor's current price (what Accept pays)
//   proposal.customerOfferKobo the customer's pending offer, null when none
//   proposal.negotiation       history [{by, action, priceKobo, at}]
// Once the vendor accepts the customer's offer it becomes priceKobo, and the
// customer accepts the proposal and pays through the normal accept flow.

const CONFIGS = {
  event: { requestModel: "eventRequest", proposalModel: "eventProposal", fk: "eventRequestId", vtype: "EVENT_PLANNER", socket: "event-request:updated", noun: "event", dataKey: "eventRequestId" },
  catering: { requestModel: "cateringRequest", proposalModel: "cateringProposal", fk: "cateringRequestId", vtype: "CATERING", socket: "catering-request:updated", noun: "catering", dataKey: "cateringRequestId" },
  cake: { requestModel: "cakeRequest", proposalModel: "cakeProposal", fk: "cakeRequestId", vtype: "CAKE", socket: "cake-request:updated", noun: "cake", dataKey: "cakeRequestId" },
};

const naira = (k) => "₦" + Math.round(k / 100).toLocaleString();

async function load(cfg, req) {
  const request = await prisma[cfg.requestModel].findUnique({ where: { id: req.params.id } });
  if (!request) return { error: [404, "Request not found."] };
  const proposal = await prisma[cfg.proposalModel].findUnique({ where: { id: req.params.proposalId } });
  if (!proposal || proposal[cfg.fk] !== request.id) return { error: [404, "Proposal not found."] };
  if (request.status !== "OPEN" || proposal.status !== "PENDING") return { error: [400, "This proposal is no longer open for negotiation."] };
  const isCustomer = request.customerId === req.user.id;
  const isVendor = !!req.user.vendorProfile && req.user.vendorProfile.id === proposal.vendorId;
  if (!isCustomer && !isVendor) return { error: [403, "You are not part of this proposal."] };
  const vendor = await prisma.vendorProfile.findUnique({ where: { id: proposal.vendorId }, select: { userId: true, bizName: true } });
  return { request, proposal, isCustomer, isVendor, vendor };
}

function tell(req, cfg, ctx, toCustomer, title, body) {
  const io = req.app.get("io");
  const userId = toCustomer ? ctx.request.customerId : ctx.vendor && ctx.vendor.userId;
  if (userId) notify(io, userId, "ORDER_UPDATE", title, body, { [cfg.dataKey]: ctx.request.id }).catch(() => {});
  io?.to(`user:${ctx.request.customerId}`).emit(cfg.socket, { requestId: ctx.request.id, reason: "negotiation" });
  io?.to(`vendor:${ctx.proposal.vendorId}`).emit(cfg.socket, { requestId: ctx.request.id, reason: "negotiation" });
}

// POST /:id/proposals/:proposalId/counter  { priceKobo }
// Customer: sends/replaces their offer. Vendor: sends a new price, which
// replaces their proposal price and clears the customer's pending offer.
function counter(kind) {
  const cfg = CONFIGS[kind];
  return async (req, res, next) => {
    try {
      const ctx = await load(cfg, req);
      if (ctx.error) return res.status(ctx.error[0]).json({ error: ctx.error[1] });
      const priceKobo = Math.round(Number(req.body.priceKobo));
      if (!priceKobo || priceKobo <= 0) return res.status(400).json({ error: "Enter a valid price." });
      const history = Array.isArray(ctx.proposal.negotiation) ? ctx.proposal.negotiation : [];
      const at = new Date().toISOString();
      let data;
      if (ctx.isCustomer) {
        if (priceKobo === ctx.proposal.priceKobo) return res.status(400).json({ error: "That is already the vendor's price — just accept it." });
        data = { customerOfferKobo: priceKobo, negotiation: [...history, { by: "CUSTOMER", action: "OFFER", priceKobo, at }] };
      } else {
        data = { priceKobo, customerOfferKobo: null, negotiation: [...history, { by: "VENDOR", action: "COUNTER", priceKobo, at }] };
      }
      const proposal = await prisma[cfg.proposalModel].update({ where: { id: ctx.proposal.id }, data });
      if (ctx.isCustomer) {
        tell(req, cfg, ctx, false, "Customer offered a new price", `The customer offered ${naira(priceKobo)} for the ${ctx.request.eventType || cfg.noun} request — accept it or send your price.`);
      } else {
        tell(req, cfg, ctx, true, "New price from " + ((ctx.vendor && ctx.vendor.bizName) || "the vendor"), `${(ctx.vendor && ctx.vendor.bizName) || "The vendor"} sent a new price of ${naira(priceKobo)} — accept it or send your offer.`);
      }
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  };
}

// POST /:id/proposals/:proposalId/accept-offer — vendor accepts the
// customer's pending offer; it becomes the proposal price, and the customer
// is told to accept & pay.
function acceptOffer(kind) {
  const cfg = CONFIGS[kind];
  return async (req, res, next) => {
    try {
      const ctx = await load(cfg, req);
      if (ctx.error) return res.status(ctx.error[0]).json({ error: ctx.error[1] });
      if (!ctx.isVendor) return res.status(403).json({ error: "Only the vendor can accept the customer's offer." });
      const offer = ctx.proposal.customerOfferKobo;
      if (!offer) return res.status(400).json({ error: "There is no offer to accept." });
      const history = Array.isArray(ctx.proposal.negotiation) ? ctx.proposal.negotiation : [];
      const proposal = await prisma[cfg.proposalModel].update({
        where: { id: ctx.proposal.id },
        data: { priceKobo: offer, customerOfferKobo: null, negotiation: [...history, { by: "VENDOR", action: "ACCEPTED", priceKobo: offer, at: new Date().toISOString() }] },
      });
      tell(req, cfg, ctx, true, "Your price was accepted", `${(ctx.vendor && ctx.vendor.bizName) || "The vendor"} accepted your offer of ${naira(offer)} — accept the proposal and pay to continue.`);
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { counter, acceptOffer };
