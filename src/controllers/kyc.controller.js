const prisma = require("../config/db");

const DOC_TYPES = ["GOVERNMENT_ID", "PROOF_OF_ADDRESS", "VEHICLE_DOCUMENT"];

async function uploadKycDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No document uploaded." });
    const { docType } = req.body;
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "Invalid document type." });

    const doc = await prisma.kycDocument.create({
      data: { userId: req.user.id, docType, fileUrl: `/uploads/${req.file.filename}` },
    });
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
