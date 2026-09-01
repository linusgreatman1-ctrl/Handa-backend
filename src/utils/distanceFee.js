// Real distance-based rider fee, computed without any external Maps API
// key (none is configured yet — see the pending-credentials memory).
// Approximates the pickup point (the shopper's registered state/LGA) and
// the drop-off point (the customer's registered state/LGA) using each
// state's real geographic centroid, then a haversine straight-line
// distance. This is a genuine, real calculation grounded in the user's
// own registered location data — not a placeholder — it just measures
// straight-line distance between state centers rather than real road
// distance between exact addresses. Swapping in a real Google Maps/Mapbox
// Distance Matrix call later only requires replacing computeDistanceKm()
// below with a real API call — every caller of estimateRiderFeeKobo()
// stays unchanged.

// Approximate centroid (lat, lng) for each Nigerian state + FCT.
const STATE_CENTROIDS = {
  "Abia": [5.4527, 7.5248], "Adamawa": [9.3265, 12.3984], "Akwa Ibom": [4.9057, 7.8537],
  "Anambra": [6.2209, 6.9370], "Bauchi": [10.7726, 9.9988], "Bayelsa": [4.7719, 6.0699],
  "Benue": [7.3369, 8.7404], "Borno": [11.8846, 13.1520], "Cross River": [5.8702, 8.5988],
  "Delta": [5.5320, 5.8987], "Ebonyi": [6.2649, 8.0137], "Edo": [6.6342, 5.9304],
  "Ekiti": [7.7190, 5.3110], "Enugu": [6.4413, 7.4986], "FCT (Abuja)": [9.0765, 7.3986],
  "Gombe": [10.2897, 11.1673], "Imo": [5.5720, 7.0588], "Jigawa": [12.2280, 9.5616],
  "Kaduna": [10.5222, 7.4383], "Kano": [12.0022, 8.5920], "Katsina": [12.9908, 7.6018],
  "Kebbi": [11.4942, 4.1994], "Kogi": [7.7337, 6.6906], "Kwara": [8.9669, 4.3874],
  "Lagos": [6.5244, 3.3792], "Nasarawa": [8.4939, 8.1998], "Niger": [9.9309, 5.5983],
  "Ogun": [6.9985, 3.4737], "Ondo": [7.2508, 5.1958], "Osun": [7.5629, 4.5200],
  "Oyo": [7.8460, 3.9313], "Plateau": [9.2182, 9.5179], "Rivers": [4.8156, 6.9778],
  "Sokoto": [13.0059, 5.2476], "Taraba": [7.9994, 10.7740], "Yobe": [12.2939, 11.4390],
  "Zamfara": [12.1704, 6.2497],
};
const DEFAULT_CENTROID = STATE_CENTROIDS["Lagos"]; // sane fallback when a state is unset/unrecognized

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Straight-line (haversine) distance in km between two [lat,lng] points.
function haversineKm([lat1, lng1], [lat2, lng2]) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// No real LGA-level coordinate table exists yet, so same-state trips use a
// small flat estimate instead of pretending to know the exact distance:
// same LGA (or LGA unknown) -> a short local hop; different LGA, same
// state -> a longer cross-town estimate. Both are clearly an
// approximation, documented here rather than presented as precise.
function computeDistanceKm(pickup, dropoff) {
  const sameState = pickup.state && dropoff.state && pickup.state === dropoff.state;
  if (sameState) {
    const sameLga = pickup.lga && dropoff.lga && pickup.lga === dropoff.lga;
    return sameLga ? 4 : 12;
  }
  const p1 = STATE_CENTROIDS[pickup.state] || DEFAULT_CENTROID;
  const p2 = STATE_CENTROIDS[dropoff.state] || DEFAULT_CENTROID;
  return haversineKm(p1, p2);
}

const BASE_FARE_KOBO = 30000; // ₦300
const PER_KM_KOBO = 5000; // ₦50/km
const MIN_FEE_KOBO = 40000; // ₦400 — matches the old flat default as a floor
const MAX_FEE_KOBO = 500000; // ₦5,000 — sanity cap against a bad/missing location producing a wild fee

// Shared by both distance sources (this file's own haversine estimate, and
// googleRoutes.service.js's real road-distance calculation) so a market's
// predicted fee is priced identically regardless of which one produced the
// km figure.
function feeKoboFromDistanceKm(km) {
  const raw = BASE_FARE_KOBO + Math.round(km * PER_KM_KOBO);
  return Math.min(MAX_FEE_KOBO, Math.max(MIN_FEE_KOBO, raw));
}

function estimateRiderFeeKobo(pickup, dropoff) {
  const km = computeDistanceKm(pickup || {}, dropoff || {});
  return { feeKobo: feeKoboFromDistanceKm(km), distanceKm: Math.round(km * 10) / 10 };
}

module.exports = { estimateRiderFeeKobo, computeDistanceKm, haversineKm, feeKoboFromDistanceKm, STATE_CENTROIDS };
