const prisma = require("../config/db");
const { logAdminAction } = require("../services/auditLog.service");

// One evolving review per user — POST acts as an upsert (matches the
// "edit your review anytime" UX most app-store reviews use), rather than
// accumulating a new row per submission the way the per-transaction
// Rating model does.
async function createOrUpdateMyReview(req, res, next) {
  try {
    const { rating, comment } = req.body;
    const score = Number(rating);
    if (!score || score < 1 || score > 5) return res.status(400).json({ error: "rating must be between 1 and 5." });
    const text = String(comment || "").trim();
    if (!text) return res.status(400).json({ error: "comment is required." });

    const review = await prisma.appReview.upsert({
      where: { userId: req.user.id },
      update: { rating: score, comment: text },
      create: { userId: req.user.id, rating: score, comment: text },
    });
    res.status(201).json({ review });
  } catch (err) {
    next(err);
  }
}

async function getMyReview(req, res, next) {
  try {
    const review = await prisma.appReview.findUnique({ where: { userId: req.user.id } });
    res.json({ review });
  } catch (err) {
    next(err);
  }
}

async function listPublicReviews(req, res, next) {
  try {
    const reviews = await prisma.appReview.findMany({
      where: { hidden: false },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
}

async function listReviewsForAdmin(req, res, next) {
  try {
    const reviews = await prisma.appReview.findMany({
      include: { user: { select: { name: true, email: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
}

async function respondToReview(req, res, next) {
  try {
    const text = String(req.body.response || "").trim();
    if (!text) return res.status(400).json({ error: "response is required." });

    const review = await prisma.appReview.update({
      where: { id: req.params.id },
      data: { response: text, respondedAt: new Date(), respondedByAdminId: req.user.id },
    });
    await logAdminAction(req.user, "APP_REVIEW_RESPONDED", "AppReview", review.id, text.slice(0, 200));
    res.json({ review });
  } catch (err) {
    next(err);
  }
}

async function setReviewHidden(req, res, next) {
  try {
    const existing = await prisma.appReview.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Review not found." });
    const hidden = req.body.hidden !== undefined ? !!req.body.hidden : !existing.hidden;

    const review = await prisma.appReview.update({ where: { id: req.params.id }, data: { hidden } });
    await logAdminAction(req.user, hidden ? "APP_REVIEW_HIDDEN" : "APP_REVIEW_UNHIDDEN", "AppReview", review.id, null);
    res.json({ review });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createOrUpdateMyReview,
  getMyReview,
  listPublicReviews,
  listReviewsForAdmin,
  respondToReview,
  setReviewHidden,
};
