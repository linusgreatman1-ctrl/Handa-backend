const prisma = require("../config/db");
const { notifyAllAdmins } = require("../services/notifications.service");

const DOC_TYPES = ["GOVERNMENT_ID", "PROOF_OF_ADDRESS", "VEHICLE_DOCUMENT", "ID_DOCUMENT"];
const ID_TYPES = ["NIN", "DRIVERS_LICENSE", "INTL_PASSPORT", "VOTERS_CARD"];
const ID_TYPE_LABELS = { NIN: "NIN", DRIVERS_LICENSE: "Driver's License", INTL_PASSPORT: "Int'l Passport", VOTERS_CARD: "Voter's Card" };

async function uploadKycDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No document uploaded." });
    const { docType, idType, idNumber } = req.body;
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "Invalid document type." });

    // ID_DOCUMENT is a linked submission -- which real ID this is, and its
    // number, always travel together with the image, never independently.
    let cleanIdType = null;
    let cleanIdNumber = null;
    if (docType === "ID_DOCUMENT") {
      if (!ID_TYPES.includes(idType)) return res.status(400).json({ error: "Select which ID type this is (NIN, Driver's License, Int'l Passport, or Voter's Card)." });
      if (!idNumber || !String(idNumber).trim()) return res.status(400).json({ error: "Enter the ID number." });
      cleanIdType = idType;
      cleanIdNumber = String(idNumber).trim();
    }

    const doc = await prisma.kycDocument.create({
      data: { userId: req.user.id, docType, idType: cleanIdType, idNumber: cleanIdNumber, fileUrl: `/uploads/${req.file.filename}` },
    });
    const label = docType === "ID_DOCUMENT" ? ID_TYPE_LABELS[cleanIdType] : docType.replace(/_/g, " ").toLowerCase();
    notifyAllAdmins(req.app.get("io"), "🪪 New KYC document", `${req.user.name || "A user"} submitted a ${label} for review.`, { kycDocumentId: doc.id }).catch(() => {});
    res.status(201).json({ document: doc });
  } catch (err) {
    next(err);
  }
}

async function listMyKycDocuments(req, res, next) {
  try {
    const documents = await prisma.kycDocument.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ documents });
  } catch (err) {
    next(err);
  }
}

// Lets an already-approved (or pending) document be removed so the user can
// upload a fresh one in its place — the next POST /kyc/documents naturally
// becomes the new PENDING doc of that type, same as the first-time/rejected
// upload flow already works.
async function deleteMyKycDocument(req, res, next) {
  try {
    const doc = await prisma.kycDocument.findUnique({ where: { id: req.params.id } });
    if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: "Document not found." });
    await prisma.kycDocument.delete({ where: { id: doc.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadKycDocument, listMyKycDocuments, deleteMyKycDocument };
