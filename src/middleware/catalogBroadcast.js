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

module.exports = { broadcastCatalogChange };
