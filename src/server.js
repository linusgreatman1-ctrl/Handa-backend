require("dotenv").config();

const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { attachLiveSocket } = require("./realtime/live");

const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const vendorsRoutes = require("./routes/vendors.routes");
const shoppersRoutes = require("./routes/shoppers.routes");
const searchRoutes = require("./routes/search.routes");
const bookingsRoutes = require("./routes/bookings.routes");
const shopSessionsRoutes = require("./routes/shopSessions.routes");
const walletRoutes = require("./routes/wallet.routes");
const paymentsRoutes = require("./routes/payments.routes");
const ratingsRoutes = require("./routes/ratings.routes");
const appReviewsRoutes = require("./routes/appReviews.routes");
const supportRoutes = require("./routes/support.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const chatRoutes = require("./routes/chat.routes");
const adminRoutes = require("./routes/admin.routes");
const configRoutes = require("./routes/config.routes");
const kycRoutes = require("./routes/kyc.routes");
const eventRequestsRoutes = require("./routes/eventRequests.routes");
const favouritesRoutes = require("./routes/favourites.routes");
const voiceRoutes = require("./routes/voice.routes");

const app = express();

// The admin panel at /admin is a single static HTML file with its logic
// in an inline <script> block (no build step) — 'unsafe-inline' on
// script-src is what lets that run at all under helmet's default CSP.
// The Paystack inline checkout script + its checkout popup, and
// Flutterwave's equivalent, are the other third-party origins this API's
// served pages need, same reasoning as passnow-backend-new's server.js.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // The Handa app at /app loads socket.io-client from a CDN (no build
        // step) and needs a websocket connect-src allowance for its own
        // origin, or the Socket.IO handshake silently falls back to
        // failing instead of connecting.
        "script-src": ["'self'", "'unsafe-inline'", "https://js.paystack.co", "https://checkout.flutterwave.com", "https://cdn.socket.io"],
        // helmet's default directives set script-src-attr to 'none'
        // SEPARATELY from script-src — that default was still blocking
        // every onclick="..." attribute in both /app and /admin even with
        // 'unsafe-inline' on script-src above, since script-src-attr is
        // its own directive that isn't inherited from script-src. Both
        // pages are built entirely on inline onclick handlers (no build
        // step, no addEventListener), so this alone made literally every
        // button in both apps inert — including login — while the page
        // itself loaded with zero visible errors unless you opened devtools.
        "script-src-attr": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "frame-src": ["'self'", "https://*.paystack.co", "https://*.paystack.com", "https://*.flutterwave.com"],
        "connect-src": ["'self'", "https://*.paystack.co", "https://*.paystack.com", "ws:", "wss:"],
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  })
);

const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  })
);

app.use(compression());
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Captures the raw request body alongside the parsed one so
// payments.controller.webhook can verify Paystack's HMAC-SHA512 signature
// (computed over the exact raw bytes, not a re-serialized JSON.stringify
// which can differ in key order/whitespace).
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use("/api", globalLimiter);

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));
app.use("/app", express.static(path.join(__dirname, "..", "public", "app")));
// Dev-staging copies of the two live files — a safe place for the admin
// Code Editor to test edits (or preview the Live Preview tab) before an
// admin manually applies the same change to the real live file.
app.use("/app-dev", express.static(path.join(__dirname, "..", "public", "app-dev")));
app.use("/admin-dev", express.static(path.join(__dirname, "..", "public", "admin-dev")));

app.get("/health", (req, res) => res.json({ status: "ok", service: "handa-backend" }));
app.use("/internal-seed", require("./routes/internalSeed.routes"));
app.use("/internal-cleanup", require("./routes/internalCleanup.routes"));
app.get("/", (req, res) => res.json({ service: "handa-backend", status: "ok", app: "/app", admin: "/admin", health: "/health", api: "/api" }));

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/vendors", vendorsRoutes);
app.use("/api/shoppers", shoppersRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/shop-sessions", shopSessionsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/ratings", ratingsRoutes);
app.use("/api/app-reviews", appReviewsRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/config", configRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/event-requests", eventRequestsRoutes);
app.use("/api/favourites", favouritesRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/voice", voiceRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
const io = attachLiveSocket(server);
app.set("io", io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Handa backend listening on port ${PORT}`);
});

module.exports = { app, server };
