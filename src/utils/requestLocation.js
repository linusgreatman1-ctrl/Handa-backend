// Event/Catering/Cake requests can be posted for a state and (optionally)
// an LGA. Only vendors registered there see them: a request with no state
// is visible to every vendor of that type (older requests, or a customer
// who didn't pick one); a state-only request to every vendor in that state;
// state + LGA narrows it to that LGA.

function cleanLocation(body) {
  const state = body && body.state ? String(body.state).trim() : "";
  const lga = body && body.lga ? String(body.lga).trim() : "";
  return { state: state || null, lga: state && lga ? lga : null };
}

// Prisma where-clause for OPEN requests a vendor at (state, lga) may see.
function visibleToVendorWhere(vendorUser) {
  const state = vendorUser && vendorUser.state;
  const lga = vendorUser && vendorUser.lga;
  return {
    AND: [
      { OR: [{ state: null }, ...(state ? [{ state }] : [])] },
      { OR: [{ lga: null }, ...(lga ? [{ lga }] : [])] },
    ],
  };
}

function vendorCanSee(request, vendorUser) {
  if (!request.state) return true;
  if (!vendorUser || request.state !== vendorUser.state) return false;
  if (request.lga && request.lga !== vendorUser.lga) return false;
  return true;
}

module.exports = { cleanLocation, visibleToVendorWhere, vendorCanSee };
