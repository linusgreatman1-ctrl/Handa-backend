// Centralized error handler. Keep this last in the middleware chain.
function errorHandler(err, req, res, next) {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  if (err.code === "P2002") {
    return res.status(409).json({ error: "A record with that value already exists." });
  }
  if (err.code === "P2025") {
    return res.status(404).json({ error: "Record not found." });
  }

  const status = err.status || 500;
  const message =
    status === 500 && process.env.NODE_ENV === "production"
      ? "An unexpected error occurred."
      : err.message || "An unexpected error occurred.";

  // A thrown insufficient-funds error (e.g. reconcileBookingEditFinancials,
  // bookings.controller.js) carries how much more is needed alongside the
  // message -- forwarded through here so the frontend can tell the
  // customer the exact top-up amount instead of just "insufficient funds."
  if (err.shortfallKobo !== undefined) {
    return res.status(status).json({ error: message, shortfallKobo: err.shortfallKobo });
  }

  res.status(status).json({ error: message });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
