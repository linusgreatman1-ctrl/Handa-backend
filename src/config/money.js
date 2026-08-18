// Money lives in the DB as Int kobo (1 NGN = 100 kobo). These convert at
// the API boundary so callers can send/receive plain naira amounts.
function nairaToKobo(naira) {
  return Math.round(Number(naira) * 100);
}

function koboToNaira(kobo) {
  return Number(kobo) / 100;
}

module.exports = { nairaToKobo, koboToNaira };
