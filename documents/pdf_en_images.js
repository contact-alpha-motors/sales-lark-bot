const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Conversion PDF -> images PNG via poppler (pdftoppm). On envoie ensuite les
// pages en tant qu'images au modele de vision : cela evite les frais "files"
// d'OpenRouter sur les PDF et lit souvent mieux le manuscrit.
// ---------------------------------------------------------------------------

const DPI = Number(process.env.PDF_DPI || 150);

function disponible() {
  return new Promise((resolve) => {
    execFile("pdftoppm", ["-v"], (err) => resolve(!err));
  });
}

function pdfEnImages(cheminPdf, dpi = DPI) {
  return new Promise((resolve, reject) => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "pdfimg-"));
    const prefixe = path.join(dossier, "page");
    execFile("pdftoppm", ["-png", "-r", String(dpi), cheminPdf, prefixe], (err) => {
      if (err) return reject(err);
      const images = fs
        .readdirSync(dossier)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => path.join(dossier, f));
      if (!images.length) return reject(new Error("pdftoppm n'a produit aucune image"));
      resolve({ images, dossier });
    });
  });
}

function nettoyer(dossier) {
  try {
    fs.rmSync(dossier, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

module.exports = { disponible, pdfEnImages, nettoyer };
