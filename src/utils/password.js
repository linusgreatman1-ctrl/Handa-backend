const bcrypt = require("bcryptjs");

const SALT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function isStrongPassword(plain) {
  return typeof plain === "string" && plain.length >= 6;
}

module.exports = { hashPassword, comparePassword, isStrongPassword };
