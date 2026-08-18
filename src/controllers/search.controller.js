const prisma = require("../config/db");

// Backs the frontend's global search bar and per-tab search boxes —
// matches vendor names and individual menu items in one call so the
// client can render both "matching stores" and "matching dishes" sections.
async function search(req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ vendors: [], items: [] });

    const [vendors, items] = await Promise.all([
      prisma.vendorProfile.findMany({
        where: { bizName: { contains: q, mode: "insensitive" } },
        include: { user: { select: { name: true } } },
        take: 20,
      }),
      prisma.menuItem.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        include: { vendor: { select: { id: true, bizName: true, vtype: true } } },
        take: 20,
      }),
    ]);

    res.json({ vendors, items });
  } catch (err) {
    next(err);
  }
}

module.exports = { search };
