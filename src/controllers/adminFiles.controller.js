// Super-admin-only "Code Editor" + "Codes" tools — live-patch the two
// static frontend files (public/app/index.html, public/admin/index.html)
// without a full git-push-and-redeploy cycle. Mirrors the pattern used in
// the sibling PassNow project (src/controllers/frontend.controller.js):
// Code Editor = targeted find/replace, Codes = full raw-file load/save.
// Every write is preceded by a timestamped backup and followed by a
// syntax-check of the file's inline <script> — a failed check aborts the
// write and nothing on disk changes, so a bad edit can never take the
// live app down the way an unreviewed change could.
const fs = require("fs");
const path = require("path");
const { logAdminAction } = require("../services/auditLog.service");

const ROOT = path.join(__dirname, "..", "..");
const BACKUP_DIR = path.join(ROOT, "backups");

// Whitelist only — "file" from the request is always looked up here, never
// used to build a path directly, so there's no path-traversal surface.
const EDITABLE_FILES = {
  "app/index.html": path.join(ROOT, "public", "app", "index.html"),
  "admin/index.html": path.join(ROOT, "public", "admin", "index.html"),
};

function resolveFile(key) {
  return EDITABLE_FILES[key] || null;
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupFileName(key, when) {
  return `${key.replace(/\//g, "_")}.${when}.bak`;
}

function writeBackup(key, content) {
  ensureBackupDir();
  const name = backupFileName(key, Date.now());
  fs.writeFileSync(path.join(BACKUP_DIR, name), content, "utf8");
  return name;
}

// Only HTML files with one inline <script> block are editable here, so a
// single extraction is enough — if a future editable file has none, the
// check is skipped rather than false-failing.
function checkScriptSyntax(content) {
  const matches = [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const m of matches) {
    new Function(m[1]); // throws SyntaxError on bad JS; never executed
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

async function listFiles(req, res, next) {
  try {
    const files = Object.entries(EDITABLE_FILES).map(([key, abs]) => {
      const stat = fs.statSync(abs);
      return { file: key, sizeBytes: stat.size, modifiedAt: stat.mtime };
    });
    res.json({ files });
  } catch (err) {
    next(err);
  }
}

async function searchInFile(req, res, next) {
  try {
    const { file, query, contextChars } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!query) return res.status(400).json({ error: "query is required." });
    const ctx = Math.min(300, Math.max(0, parseInt(contextChars) || 60));

    const content = fs.readFileSync(abs, "utf8");
    const matches = [];
    let idx = 0;
    while (matches.length < 30) {
      idx = content.indexOf(query, idx);
      if (idx === -1) break;
      matches.push({
        occurrenceIndex: matches.length,
        before: content.slice(Math.max(0, idx - ctx), idx),
        match: query,
        after: content.slice(idx + query.length, idx + query.length + ctx),
        charOffset: idx,
      });
      idx += query.length;
    }
    const totalOccurrences = countOccurrences(content, query);
    res.json({ matches, totalOccurrences, truncated: totalOccurrences > matches.length });
  } catch (err) {
    next(err);
  }
}

async function replaceInFile(req, res, next) {
  try {
    const { file, find, replaceWith, occurrenceIndex, replaceAll } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!find) return res.status(400).json({ error: "find is required." });
    if (replaceWith === undefined || replaceWith === null) return res.status(400).json({ error: "replaceWith is required." });

    const content = fs.readFileSync(abs, "utf8");
    const total = countOccurrences(content, find);
    if (total === 0) return res.status(404).json({ error: "No occurrences of that text found." });

    let newContent;
    if (replaceAll) {
      newContent = content.split(find).join(replaceWith);
    } else if (occurrenceIndex !== undefined && occurrenceIndex !== null) {
      const n = parseInt(occurrenceIndex);
      if (n < 0 || n >= total) return res.status(400).json({ error: `occurrenceIndex out of range (0-${total - 1}).` });
      let idx = -1;
      for (let i = 0; i <= n; i++) idx = content.indexOf(find, idx + 1);
      newContent = content.slice(0, idx) + replaceWith + content.slice(idx + find.length);
    } else if (total === 1) {
      const idx = content.indexOf(find);
      newContent = content.slice(0, idx) + replaceWith + content.slice(idx + find.length);
    } else {
      return res.status(409).json({ error: "Text is not unique in this file.", occurrences: total });
    }

    try {
      checkScriptSyntax(newContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "Replacement would break the page's script syntax: " + syntaxErr.message });
    }

    const backupName = writeBackup(file, content);
    fs.writeFileSync(abs, newContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_REPLACE", "FILE", file, `Replaced ${replaceAll ? total : 1} occurrence(s) of "${find.slice(0, 60)}" — backup: ${backupName}`);
    res.json({ success: true, replacedCount: replaceAll ? total : 1, backupName });
  } catch (err) {
    next(err);
  }
}

async function listBackups(req, res, next) {
  try {
    ensureBackupDir();
    const { file } = req.query;
    const names = fs.readdirSync(BACKUP_DIR).filter((n) => n.endsWith(".bak") && (!file || n.startsWith(file.replace(/\//g, "_") + ".")));
    const backups = names
      .map((name) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, sizeBytes: stat.size, createdAt: stat.mtime };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ backups });
  } catch (err) {
    next(err);
  }
}

async function restoreBackup(req, res, next) {
  try {
    const { file, backupName } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!backupName || typeof backupName !== "string") return res.status(400).json({ error: "backupName is required." });

    const backupPath = path.join(BACKUP_DIR, backupName);
    // Confirm the resolved path is actually inside BACKUP_DIR and belongs
    // to this file — blocks any "../" style backupName from escaping.
    if (path.dirname(backupPath) !== BACKUP_DIR || !backupName.startsWith(file.replace(/\//g, "_") + ".")) {
      return res.status(400).json({ error: "Invalid backup." });
    }
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: "Backup not found." });

    const backupContent = fs.readFileSync(backupPath, "utf8");
    try {
      checkScriptSyntax(backupContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "That backup itself fails a syntax check — refusing to restore it: " + syntaxErr.message });
    }

    const current = fs.readFileSync(abs, "utf8");
    const safetyBackupName = writeBackup(file, current); // so restoring is itself undoable
    fs.writeFileSync(abs, backupContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_RESTORE", "FILE", file, `Restored from ${backupName} — pre-restore safety backup: ${safetyBackupName}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getContent(req, res, next) {
  try {
    const { file } = req.query;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    const content = fs.readFileSync(abs, "utf8");
    res.type("text/plain").send(content);
  } catch (err) {
    next(err);
  }
}

async function saveContent(req, res, next) {
  try {
    const { file, confirmDrasticShrink } = req.query;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    const newContent = req.body;
    if (typeof newContent !== "string" || !newContent.length) {
      return res.status(400).json({ error: "Request body must be the full file content as text." });
    }

    const current = fs.readFileSync(abs, "utf8");
    if (newContent.length < current.length * 0.5 && confirmDrasticShrink !== "true") {
      return res.status(409).json({
        error: "New content is less than half the current file's size — this often means the editor lost its contents. Resubmit with confirmDrasticShrink=true if this is intentional.",
        currentSizeBytes: current.length,
        newSizeBytes: newContent.length,
      });
    }

    try {
      checkScriptSyntax(newContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "New content fails a script syntax check: " + syntaxErr.message });
    }

    const backupName = writeBackup(file, current);
    fs.writeFileSync(abs, newContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_SAVE", "FILE", file, `Full-file save — backup: ${backupName}`);
    res.json({ success: true, backupName });
  } catch (err) {
    next(err);
  }
}

module.exports = { listFiles, searchInFile, replaceInFile, listBackups, restoreBackup, getContent, saveContent };
