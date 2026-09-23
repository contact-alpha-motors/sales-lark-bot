const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const DOSSIER = process.env.EXPORTS_DOSSIER || path.join(__dirname, "..", "exports");

// Rendu d'un tableau de lignes homogenes en PDF paysage. Pur JS (pdfkit),
// aucune dependance systeme : pas de LibreOffice ni de Chromium dans l'image.
function exporterPdf(nomFichier, lignes, titre = "") {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(DOSSIER, { recursive: true });
    const chemin = path.join(DOSSIER, nomFichier);

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const flux = fs.createWriteStream(chemin);
    doc.pipe(flux);

    const gaucheX = doc.page.margins.left;
    const largeurUtile = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font("Helvetica-Bold").fontSize(15).fillColor("#111").text(titre || "Liste", { align: "left" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9).fillColor("#666")
      .text(`Alpha Motors — ${lignes.length} ligne(s)`, { align: "left" });
    doc.fillColor("#000").moveDown(0.5);

    if (!lignes.length) {
      doc.font("Helvetica").fontSize(11).text("Aucun resultat.");
      doc.end();
      flux.on("finish", () => resolve(chemin));
      flux.on("error", reject);
      return;
    }

    const colonnes = Object.keys(lignes[0]);
    const libelles = colonnes.map((c) => c.replace(/_/g, " ").toUpperCase());
    const largeurCol = largeurUtile / colonnes.length;
    const marge = 4;

    function dessinerLigne(cellules, y, gras) {
      doc.font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);

      let hauteur = 0;
      cellules.forEach((txt) => {
        const h = doc.heightOfString(String(txt ?? ""), { width: largeurCol - 2 * marge });
        if (h > hauteur) hauteur = h;
      });
      hauteur += 2 * marge;

      if (y + hauteur > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      cellules.forEach((txt, i) => {
        const x = gaucheX + i * largeurCol;
        if (gras) doc.rect(x, y, largeurCol, hauteur).fill("#f0f0f0");
        doc.rect(x, y, largeurCol, hauteur).stroke("#cccccc");
        doc.fillColor(gras ? "#000" : "#222")
          .font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
          .text(String(txt ?? ""), x + marge, y + marge, { width: largeurCol - 2 * marge });
      });

      return y + hauteur;
    }

    let y = doc.y;
    y = dessinerLigne(libelles, y, true);
    for (const ligne of lignes) {
      y = dessinerLigne(colonnes.map((c) => ligne[c]), y, false);
    }

    doc.end();
    flux.on("finish", () => resolve(chemin));
    flux.on("error", reject);
  });
}

module.exports = { exporterPdf };
