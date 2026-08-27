-- Display-only tags for Home Cook meal-picker packages (3-Day Meal Prep,
-- Weekly Family Meals, Multiple Meals Package, Event Catering Package),
-- which never carry a real servicePackageId -- without these, "Package"
-- in booking details always showed "--" for them.
ALTER TABLE "Booking" ADD COLUMN "packageKey" TEXT;
ALTER TABLE "Booking" ADD COLUMN "packageLabel" TEXT;
