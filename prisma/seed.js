// Minimal demo dataset so the API has something to browse immediately
// after `npm run seed` — one vendor per catalog tab the frontend has
// (restaurant, grocery, caterer, home cook, event planner, cake
// designer), plus a rider, a shopper, and a customer. Not meant as
// exhaustive fixture data — just enough to click through every screen.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function hash(pw) {
  return bcrypt.hash(pw, 10);
}

async function makeUser({ name, email, phone, role, extra = {} }) {
  return prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash: await hash("password123"),
      role,
      address: "12 Adeola Odeku, Victoria Island, Lagos",
      state: "Lagos",
      lga: "Eti-Osa",
      bankName: "GTBank",
      bankAccountNumber: "0123456789",
      bankAccountName: name,
      wallet: { create: {} },
      notificationPref: { create: {} },
      ...extra,
    },
  });
}

async function main() {
  console.log("Seeding Handa demo data...");

  const customer = await makeUser({ name: "Ada Customer", email: "ada@example.com", phone: "+2348010000001", role: "CUSTOMER" });

  const groceryOwner = await makeUser({
    name: "Amina Grocery",
    email: "grocery@example.com",
    phone: "+2348010000003",
    role: "VENDOR",
    extra: {
      vendorProfile: {
        create: {
          vtype: "GROCERY",
          bizName: "Mile 12 Fresh Market",
          emoji: "🥬",
          tags: ["Tubers", "Grains", "Vegetables"],
          isOnline: true, isVerified: true,
          baseDeliveryFeeKobo: 50000,
          menuItems: {
            create: [
              { name: "Tomatoes", priceKobo: 150000, unit: "basket", category: "Vegetables", emoji: "🍅" },
              { name: "Rice", priceKobo: 6500000, unit: "50kg bag", category: "Grains", emoji: "🌾" },
              { name: "Yam Tubers", priceKobo: 200000, unit: "tuber", category: "Tubers", emoji: "🍠" },
            ],
          },
        },
      },
    },
  });

  const catererOwner = await makeUser({
    name: "Funke Caterer",
    email: "caterer@example.com",
    phone: "+2348010000004",
    role: "VENDOR",
    extra: {
      vendorProfile: {
        create: {
          vtype: "CATERER",
          bizName: "Funke's Delicious Catering",
          emoji: "🍽️",
          tags: ["Weddings", "Corporate"],
          isOnline: true, isVerified: true,
          servicePackages: {
            create: [
              { key: "BASIC", label: "Basic (50 guests)", priceKobo: 15000000, includes: ["Jollof rice", "Chicken", "Salad", "Drinks"] },
              { key: "STANDARD", label: "Standard (100 guests)", priceKobo: 28000000, includes: ["3 rice options", "2 proteins", "Salad", "Small chops", "Drinks"] },
              { key: "PREMIUM", label: "Premium (200 guests)", priceKobo: 55000000, includes: ["Full menu", "Live cooking station", "Dessert bar", "Drinks", "Waitstaff"] },
            ],
          },
        },
      },
    },
  });

  const cookOwner = await makeUser({
    name: "Ngozi Cook",
    email: "cook@example.com",
    phone: "+2348010000005",
    role: "VENDOR",
    extra: {
      vendorProfile: {
        create: {
          vtype: "HOME_COOK",
          bizName: "Ngozi's Home Kitchen",
          emoji: "👩‍🍳",
          tags: ["Igbo cuisine", "Meal prep"],
          isOnline: true, isVerified: true,
          hourlyRateKobo: 500000,
          ratePeriod: "per session",
          menuItems: { create: [{ name: "Ofe Nsala Special", priceKobo: 450000, emoji: "🍲", popular: true }] },
        },
      },
    },
  });

  const epOwner = await makeUser({
    name: "Tolu Planner",
    email: "eventplanner@example.com",
    phone: "+2348010000006",
    role: "VENDOR",
    extra: {
      vendorProfile: {
        create: {
          vtype: "EVENT_PLANNER",
          bizName: "Tolu Events Co.",
          emoji: "🎉",
          tags: ["Weddings", "Birthdays", "Corporate"],
          isOnline: true, isVerified: true,
          servicePackages: {
            // All 8 fixed package types the frontend's event-planner booking
            // screen offers (see _epPackages in public/app/index.html) —
            // every event planner needs one row per key or booking a type
            // this vendor doesn't have a row for fails with "not offered".
            create: [
              { key: "BASIC", label: "Basic Event Package", priceKobo: 15000000, includes: ["Event coordination", "Basic decor setup", "Guest management"] },
              { key: "STANDARD", label: "Standard Package", priceKobo: 35000000, includes: ["Full event coordination", "Premium decor", "Catering liaison", "MC/Host"] },
              { key: "PREMIUM", label: "Premium Package", priceKobo: 75000000, includes: ["End-to-end planning", "Luxury decor", "MC & entertainment", "Full photography"] },
              { key: "WEDDING", label: "Wedding Package", priceKobo: 120000000, includes: ["Full planning", "Decor", "Photography", "Coordination"] },
              { key: "CORPORATE", label: "Corporate Event", priceKobo: 50000000, includes: ["Corporate planning", "AV & tech setup", "Branding coordination"] },
              { key: "BIRTHDAY", label: "Birthday Package", priceKobo: 20000000, includes: ["Decor", "MC", "Photography"] },
              { key: "BURIAL", label: "Funeral / Memorial", priceKobo: 18000000, includes: ["Funeral coordination", "Venue arrangement", "Floral arrangements"] },
              { key: "NAMING", label: "Naming Ceremony", priceKobo: 12000000, includes: ["Ceremony coordination", "Decor setup", "Catering liaison"] },
            ],
          },
        },
      },
    },
  });

  const cakeOwner = await makeUser({
    name: "Bisi Cakes",
    email: "cakes@example.com",
    phone: "+2348010000007",
    role: "VENDOR",
    extra: {
      vendorProfile: {
        create: {
          vtype: "CAKE_DESIGNER",
          bizName: "Bisi's Custom Cakes",
          emoji: "🎂",
          isOnline: true, isVerified: true,
          menuItems: {
            create: [
              { name: "2-Tier Wedding Cake", priceKobo: 4500000, deliveryDays: 3, emoji: "🎂", category: "Wedding" },
              { name: "Birthday Cake (Small)", priceKobo: 1200000, deliveryDays: 1, emoji: "🎂", category: "Birthday" },
            ],
          },
        },
      },
    },
  });

  await makeUser({
    name: "Emeka Rider",
    email: "rider@example.com",
    phone: "+2348010000008",
    role: "RIDER",
    extra: { riderProfile: { create: { vehicleType: "Motorcycle", plateNumber: "LG-234-NK", isOnline: true, isVerified: true, ratingAvg: 4.9, ratingCount: 340, deliveries: 1240, acceptRate: 94 } } },
  });

  await makeUser({
    name: "Kemi Shopper",
    email: "shopper@example.com",
    phone: "+2348010000009",
    role: "SHOPPER",
    extra: { shopperProfile: { create: { market: "Mile 12 Market", isOnline: true, isVerified: true, specialties: ["Vegetables", "Spices"] } } },
  });

  // Logs into the /admin panel — see public/admin/index.html.
  await prisma.user.create({
    data: {
      name: "Handa Admin",
      email: "linusgreatman1@gmail.com",
      passwordHash: await hash("admin12345"),
      role: "ADMIN",
      wallet: { create: {} },
      notificationPref: { create: {} },
    },
  });

  console.log("Seed complete. Demo login: any seeded email + password: password123");
}

// Reusable from src/routes/internalSeed.routes.js (a one-time HTTP trigger
// used when direct external DB access to the host isn't available), as
// well as from the CLI (`npm run seed`) below.
module.exports = main;

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
