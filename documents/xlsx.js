const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const DOSSIER = process.env.EXPORTS_DOSSIER || path.join(__dirname, "..", "exports");

// Transforme des lignes homogenes (tableaux d'objets) en fichier Excel.
// Les cles du premier objet donnent les colonnes.
async function exporterXlsx(nomFichier, lignes, titre = "") {
  fs.mkdirSync(DOSSIER, { recursive: true });

  const classeur = new ExcelJS.Workbook();
  const feuille = classeur.addWorksheet(titre || "Export");

  if (lignes.length) {
    const colonnes = Object.keys(lignes[0]);
    feuille.columns = colonnes.map((c) => ({
      header: c.replace(/_/g, " ").toUpperCase(),
      key: c,
      width: Math.max(14, c.length + 4),
    }));
    feuille.getRow(1).font = { bold: true };
    lignes.forEach((l) => feuille.addRow(l));
  }

  const chemin = path.join(DOSSIER, nomFichier);
  await classeur.xlsx.writeFile(chemin);
  return chemin;
}

module.exports = { exporterXlsx };
