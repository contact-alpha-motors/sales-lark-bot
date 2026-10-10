#!/usr/bin/env node
"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { disponible: popplerDispo, pdfEnImages, nettoyer } = require("../documents/pdf_en_images");

// ---------------------------------------------------------------------------
// Test OCR d'UNE page de fiche sur un/des modeles vision (gratuits ou non),
// pour juger la QUALITE de lecture avant de s'y fier. N'ecrit rien.
//
//   OPENROUTER_TEST_KEY=sk-or-... node scripts/test_ocr.js [image|pdf]
//   (option) MODELES_TEST="dots-studio/dots-3-note-preview:free,autre:free"
//
// Sans argument : prend la page la plus recente du corpus archive
// (data/ocr_images/<hash>/page-01.png).
// ---------------------------------------------------------------------------

const BASE = process.env.IA_BASE_URL || "https://openrouter.ai/api/v1";
const CLE = process.env.OPENROUTER_TEST_KEY || process.env.OPENROUTER_API_KEY;
const MODELES = (process.env.MODELES_TEST || "dots-studio/dots-3-note-preview:free")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const INSTRUCTION = `Ceci est UNE page d'une FICHE D'APPEL manuscrite d'Alpha Motors (concession auto).
Renvoie UNIQUEMENT du JSON : {"agent":"<en-tete ou ''>","date":"<en-tete ou ''>","lignes":[{"nom":"","telephone":"<chiffres>","code_resultat":"<code manuscrit: NRP, RDV, NR, PI, BL, PL...>","commentaire":""}]}
Lis TOUTES les lignes. Ne corrige pas les numeros. Info absente = "".`;

function imagePart(chemin, mime) {
  const b64 = fs.readFileSync(chemin).toString("base64");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
}

// Trouve la page de corpus la plus recente si aucun argument.
function pageAuto() {
  const dir = process.env.OCR_IMAGES_DIR || path.join(__dirname, "..", "data", "ocr_images");
  if (!fs.existsSync(dir)) return null;
  const hashes = fs.readdirSync(dir).map((h) => ({ h, p: path.join(dir, h) }))
    .filter((x) => { try { return fs.statSync(x.p).isDirectory(); } catch { return false; } })
    .sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
  for (const { p } of hashes) {
    const png = fs.readdirSync(p).filter((f) => /\.png$/i.test(f)).sort()[0];
    if (png) return path.join(p, png);
  }
  return null;
}

async function imagePourFichier(chemin) {
  const ext = path.extname(chemin).toLowerCase();
  if (ext === ".pdf") {
    if (!(await popplerDispo())) throw new Error("poppler indisponible pour lire le PDF");
    const { images, dossier } = await pdfEnImages(chemin);
    return { part: imagePart(images[0], "image/png"), pages: images.length, nettoyage: () => nettoyer(dossier) };
  }
  const mime = MIME[ext];
  if (!mime) throw new Error(`Type non lisible : ${ext}`);
  return { part: imagePart(chemin, mime), pages: 1, nettoyage: () => {} };
}

async function tester(modele, part) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modele, messages: [{ role: "user", content: [{ type: "text", text: INSTRUCTION }, part] }], temperature: 0.1, usage: { include: true } }),
      signal: AbortSignal.timeout(90000),
    });
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    const j = await r.json();
    if (j.error) return console.log(`\n### ${modele}\n   ERREUR (${ms}s): ${j.error.message}`);
    const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "";
    const cout = j.usage && j.usage.cost != null ? `$${j.usage.cost.toFixed(5)}` : "coût ?";
    let nb = "?"; try { const o = JSON.parse(txt.replace(/```(?:json)?/g, "").trim()); nb = Array.isArray(o.lignes) ? o.lignes.length : "?"; } catch {}
    console.log(`\n### ${modele}  (${ms}s, ${cout}, ${nb} lignes lues)\n${txt.slice(0, 1800)}`);
  } catch (e) {
    console.log(`\n### ${modele}\n   EXCEPTION: ${e.message}`);
  }
}

(async () => {
  if (!CLE) { console.error("! Mets OPENROUTER_TEST_KEY (ou OPENROUTER_API_KEY)."); process.exit(1); }
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const chemin = arg || pageAuto();
  if (!chemin) { console.error("! Aucune image fournie et aucune page trouvee dans data/ocr_images. Donne un chemin: node scripts/test_ocr.js /app/downloads/fiche.pdf"); process.exit(1); }
  console.log(`=== Test OCR sur : ${chemin} ===`);
  const { part, pages, nettoyage } = await imagePourFichier(chemin);
  if (pages > 1) console.log(`(PDF de ${pages} pages — on teste la page 1 seulement pour economiser le quota)`);
  try { for (const m of MODELES) await tester(m, part); } finally { nettoyage(); }
  console.log("");
})().catch((e) => { console.error("ECHEC:", e); process.exit(1); });
