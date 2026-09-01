// Real road-distance calculation for the Shop-For-Me predicted rider fee,
// via Google's Routes API. Address-based waypoints (not pre-geocoded
// lat/lng) -- Google resolves the free-text market name and delivery
// address itself, so no separate Geocoding API call is needed.
//
// Gated behind GOOGLE_MAPS_API_KEY (a Google Cloud API key with the Routes
// API enabled) -- unset in this environment as of this writing (see the
// pending-credentials memory). Every caller MUST handle the rejection this
// throws when the key is missing or the request fails, falling back to
// distanceFee.js's existing state/LGA-centroid haversine estimate instead
// of breaking session creation.
function googleRoutesEnabled() {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

// Returns { distanceKm } for the driving route between two free-text
// addresses. Throws on a missing key, a non-2xx response, or an
// unrecognized address (Google returns no routes) -- callers catch and
// fall back, this never silently returns a made-up distance.
async function computeRouteDistanceKm(originAddress, destinationAddress) {
  if (!googleRoutesEnabled()) {
    throw Object.assign(new Error("GOOGLE_MAPS_API_KEY is not configured."), { status: 503 });
  }
  const fetch = (await import("node-fetch")).default;
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { address: originAddress },
      destination: { address: destinationAddress },
      travelMode: "DRIVE",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Google Routes API request failed (${res.status}): ${body.slice(0, 200)}`), { status: 502 });
  }
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || typeof route.distanceMeters !== "number") {
    throw Object.assign(new Error("Google Routes API returned no usable route for this address pair."), { status: 502 });
  }
  return { distanceKm: route.distanceMeters / 1000 };
}

module.exports = { googleRoutesEnabled, computeRouteDistanceKm };
