// After a vendor successfully changes anything customers see (menu items,
// photos, packages, profile, avatar), tell every connected app so a customer
// already looking at that vendor sees it without refreshing.
function broadcastCatalogChange(req, res, next) {
  if (req.method === "GET") return next();
  res.on("finish", () => {
    const vendorId = req.user && req.user.vendorProfile && req.user.vendorProfile.id;
    if (!vendorId || res.statusCode >= 300) return;
    req.app.get("io")?.emit("catalog:updated", { vendorId });
  });
  next();
}

// Any successful change a user makes to their own account (details,
// vendor/rider/shopper profile, photo, bank, addresses) -- tell every admin
// dashboard so what it shows is never out of date.
function broadcastUserChange(req, res, next) {
  if (req.method === "GET") return next();
  res.on("finish", () => {
    if (!req.user || res.statusCode >= 300) return;
    req.app.get("io")?.to("admins-all").emit("admin:user-updated", { userId: req.user.id });
  });
  next();
}

module.exports = { broadcastCatalogChange, broadcastUserChange };
