# Handa Backend

**Live**: https://handa-backend.onrender.com (Render free tier — web service + Postgres. Migrated off Railway once its free trial expired; see "Hosting" below).
**App**: https://handa-backend.onrender.com/app — the actual Handa frontend, wired to this backend.
**Admin panel**: https://handa-backend.onrender.com/admin — log in with `linusgreatman1@gmail.com` / `admin12345`.
Demo logins for other roles: any seeded email (see `prisma/seed.js`) + `password123`.

`DEV_BYPASS_PAYMENTS=true` is set on this deployment — every "pay by wallet" step succeeds regardless of balance, so the whole app can be clicked through without needing real Paystack funds. Turn it off before this is a real product.

## Hosting

Free-tier Render, not Railway — Railway's trial credit ran out and this
project never had a payment method attached. Two things to know about
Render's free tier specifically:
- The **web service** sleeps after ~15 min idle; the next request takes
  ~30-50s to wake it back up. Not an issue for active development.
- The **Postgres database** is free for 30 days from creation, then Render
  requires upgrading it to keep the data — see the dashboard for the
  expiry date and to upgrade when that time comes.

There is no RESTAURANT vendor type or restaurant/dish ordering anywhere in
this product — removed after confirming the frontend never actually
exposed a screen for it (see "What this replaces" below).

Backend API for **Handa — Shop · Cook · Plan · Events**, built against the
frontend prototype at `Handa App.html` (the newer of the two files in
Downloads — `Handa.html` is an earlier draft with hardcoded wallet/bank
values the App version fixed). Node/Express + Prisma/PostgreSQL + JWT +
Socket.IO + Paystack, following the same conventions as `passnow-backend-new`.

## What this replaces

The prototype's entire app state lives in one in-memory JS object (`S`/`D`)
with fake data and `setTimeout`-simulated delivery/escrow timers. This
backend gives it a real database, real auth, real payments (Paystack), and
real-time updates (Socket.IO) — every button in the frontend that currently
ends in `toast('...')` has a matching endpoint here.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT secrets, PAYSTACK keys
npm run prisma:migrate # creates the database schema
npm run seed            # optional: one demo vendor per catalog tab + a rider/shopper/customer
npm run dev
```

Server listens on `PORT` (default 4000). `GET /health` for a liveness check.

### Required env vars (see `.env.example`)

- `DATABASE_URL` — Postgres connection string (Render/Railway free Postgres works)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — long random strings
- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — from the Paystack dashboard (test keys are fine for dev)
- `CORS_ORIGINS` — comma-separated list of frontend origins allowed to send cookies

Register a webhook in the Paystack dashboard pointing at
`https://<your-domain>/api/payments/webhook` for `charge.success`,
`transfer.success`, `transfer.failed`, and `transfer.reversed` events —
this is what finalizes payments and withdrawals even if the customer
closes the tab before the frontend's own verify-poll runs.

## Data model

See `prisma/schema.prisma`. Five roles (`CUSTOMER`, `VENDOR`, `RIDER`,
`SHOPPER`, `ADMIN`); a `VENDOR` account carries a `VendorProfile` with a
`vtype` (`HOME_COOK` / `EVENT_PLANNER`). Money is stored as `Int` kobo
throughout (Paystack's own unit), never float.

Every booking/live-shopping session is paid into `EscrowHold` rows
(one per beneficiary: vendor, rider, shopper) before any vendor/rider/
shopper wallet is credited — see `src/services/escrow.service.js`. A
background sweep (`realtime/live.js`) auto-releases holds past their
`autoReleaseAt` window, replacing the frontend's client-side countdown
timers, which stopped running the moment a tab closed.

## API surface

All routes are under `/api`. Auth is a Bearer access token (15min) +
httpOnly refresh cookie (30d, rotated on use).

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `/login`, `/guest`, `/refresh`, `/logout`, `GET /auth/me` |
| Users | `PATCH /users/me`, `/me/vendor-profile`, `/me/rider-profile`, `/me/shopper-profile`, `/me/availability` (go online/offline), `POST /me/avatar`, bank linking, addresses, notification prefs |
| Catalog | `GET /vendors` (filter by `vtype`), `GET /vendors/:id`, vendor-owned `POST/PUT/DELETE /vendors/me/menu`, `.../me/packages`, `GET /shoppers`, shopper's `.../me/sellers` |
| Search | `GET /search?q=` |
| Bookings | `POST /bookings` (home-cook/event-planning), accept/decline/pay/complete/cancel |
| Shop-For-Me | `POST /shop-sessions` through match → live call → packaging → find-rider → delivery → confirm, plus item pricing/approval and market-seller payouts |
| Wallet | `GET /wallet`, `/wallet/transactions`, `POST /wallet/withdraw` |
| Payments | Paystack initialize/verify/webhook, commission & feature-boost payments |
| Ratings | `POST /ratings` (vendor/rider/shopper, per booking/session) |
| Support | `POST /support/tickets`, admin triage |
| Notifications | `GET /notifications`, mark read |
| Chat | `POST /chat/threads`, `GET/POST .../messages` |

## Real-time (Socket.IO)

Connect with `auth: { token: accessToken }`. Rooms: `order:{id}`,
`booking:{id}`, `shop-session:{id}`, `chat:{threadId}`, plus
`dispatch:riders` / `dispatch:shoppers` (auto-joined while online) for new
delivery/session broadcasts, and `vendor:{vendorProfileId}` for new-order
alerts. `rider:location` events update `RiderProfile` and rebroadcast to
whichever order/session room that rider is currently active in — this is
what should replace the frontend's animated SVG rider-map placeholder.
WebRTC `webrtc:offer/answer/ice-candidate` are relayed for the Shop-For-Me
live video call (video itself is peer-to-peer, never through this server).

## Known simplifications

- Card numbers are never stored — `SavedPaymentMethod` only keeps a
  Paystack `authorizationCode`, matching how the prototype's client-side
  `_savedCards[]` (raw masked PAN in the DOM) should never have worked in
  production.
- Cancellation refunds land as wallet credit rather than reversing the
  original Paystack charge — simpler, and matches how most Nigerian
  marketplace apps handle this.
- Commission periods (`CommissionPeriod`) are computed on-demand when a
  vendor's dashboard requests the current week's figure; a real deployment
  should also run this on a weekly cron so overdue periods get flagged
  even if the vendor never opens the app that week.
