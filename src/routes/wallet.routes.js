const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/wallet.controller");

const router = express.Router();
router.use(requireAuth);

router.get("/", ctrl.getWallet);
router.get("/escrow-summary", ctrl.getEscrowSummary);
router.get("/transactions", ctrl.listTransactions);
router.get("/withdrawals", ctrl.listWithdrawals);
router.post("/withdraw", ctrl.requestWithdrawal);

module.exports = router;
