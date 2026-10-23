const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Fiche d'appels branded (gabarit "Suivi_Appels" ALPHA MOTORS), format paysage.
// Sert aux DEUX usages : RDV du jour (a confirmer, H-1) et RDV non honores
// (relance). Colonnes du gabarit + grille UNIQUE de resultats a cocher, alignee
// sur les categories maison pour que le scan-retour reinjecte dans Odoo.
//
//   genererFicheAppel({ nomFichier, titre, sousTitre, lignes }) -> chemin PDF
//   lignes[] = { client, comment, tel, heure, appeler, veh, agent, prisle, notes }
// ---------------------------------------------------------------------------

const DOSSIER = process.env.EXPORTS_DOSSIER || path.join(__dirname, "..", "exports");
const IMG_HAUT = path.join(__dirname, "assets", "entete_haut.jpeg");
const IMG_BAS = path.join(__dirname, "assets", "entete_bas.jpeg");

const ROUGE = "#7a1f28", TRAIT = "#b0b0b0";
const COLS = [
  { t: "N°", w: 22 },
  { t: "Heure\ndu RDV", w: 38 },
  { t: "Appeler\nà", w: 38 },
  { t: "Client", w: 124 },
  { t: "Téléphone", w: 62 },
  { t: "Véhicule", w: 60 },
  { t: "Agent (a obtenu le RDV)", w: 84 },
  { t: "RDV\npris le", w: 44 },
  { t: "Résultat de l'appel", w: 210 },
  { t: "Notes", w: 100 },
];
const M = 30;

function genererFicheAppel({ nomFichier, titre, sousTitre, lignes }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(DOSSIER, { recursive: true });
    const chemin = path.join(DOSSIER, nomFichier);
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: M });
    const flux = fs.createWriteStream(chemin);
    doc.pipe(flux);
    dessiner(doc, { titre, sousTitre }, lignes || []);
    doc.end();
    flux.on("finish", () => resolve(chemin));
    flux.on("error", reject);
  });
}

function dessiner(doc, meta, lignes) {
  const W = doc.page.width - 2 * M;
  const footH = 56;
  const pageBas = doc.page.height - M - footH - 6;
  let y, page = 0;

  const boite = (x, yy) => doc.lineWidth(0.6).strokeColor("#333").rect(x, yy, 6, 6).stroke();
  function resultat(x, yy, w) {
    doc.font("Helvetica").fontSize(6.3).fillColor("#000");
    let cy = yy + 3;
    boite(x + 2, cy); doc.text("RDV confirmé / fixé le ___/___ à ___h___", x + 11, cy - 0.5, { width: w - 12 });
    cy += 10;
    boite(x + 2, cy); doc.text("NRP", x + 11, cy - 0.5);
    boite(x + 48, cy); doc.text("Injoignable", x + 57, cy - 0.5);
    cy += 10;
    boite(x + 2, cy); doc.text("Pas intéressé / Annulé", x + 11, cy - 0.5);
    boite(x + 118, cy); doc.text("Rappeler le ___/___", x + 127, cy - 0.5);
  }

  function entete() {
    page++;
    y = M;
    try { doc.image(IMG_HAUT, (doc.page.width - 230) / 2, y, { width: 230 }); } catch (e) { /* asset manquant */ }
    y += 52;
    doc.fillColor(ROUGE).font("Helvetica-Bold").fontSize(14).text(meta.titre || "", M, y, { width: W, align: "center" });
    y += 19;
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text(meta.sousTitre || "", M, y, { width: W, align: "center" });
    y += 16;
    doc.font("Helvetica").fontSize(9).fillColor("#000")
      .text("Établie par le Service Analytique          Appels passés par : ____________________          Signature : ______________", M, y, { width: W, align: "center" });
    y += 18;
    enteteTable();
    doc.font("Helvetica").fontSize(8).fillColor("#666").text("Page " + page, doc.page.width - M - 60, M, { width: 60, align: "right" });
  }
  function enteteTable() {
    const h = 20; let x = M;
    doc.rect(M, y, W, h).fill(ROUGE);
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(7);
    for (const c of COLS) { doc.text(c.t, x + 2, y + 3, { width: c.w - 4, align: "center" }); x += c.w; }
    y += h;
  }
  function pied() {
    try { doc.image(IMG_BAS, (doc.page.width - 620) / 2, doc.page.height - M - footH, { width: 620 }); } catch (e) { /* asset manquant */ }
  }

  entete();
  lignes.forEach((lg, i) => {
    doc.font("Helvetica").fontSize(7.5);
    const nomH = doc.heightOfString(lg.client || "", { width: COLS[3].w - 4 });
    const comH = lg.comment ? doc.fontSize(6.3).heightOfString(lg.comment, { width: COLS[3].w - 4 }) : 0;
    const h = Math.max(40, nomH + comH + 8);
    if (y + h > pageBas) { pied(); doc.addPage(); entete(); }
    let x = M;
    doc.lineWidth(0.4).strokeColor(TRAIT);
    for (const c of COLS) { doc.rect(x, y, c.w, h).stroke(); x += c.w; }
    const cells = [String(i + 1), lg.heure, lg.appeler, null, lg.tel, lg.veh, lg.agent, lg.prisle, null, lg.notes];
    x = M;
    for (let k = 0; k < COLS.length; k++) {
      const c = COLS[k];
      if (k === 3) {
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(7.5).text(lg.client || "", x + 2, y + 3, { width: c.w - 4 });
        if (lg.comment) doc.font("Helvetica").fontSize(6.3).fillColor("#444").text(lg.comment, x + 2, y + 3 + nomH + 1, { width: c.w - 4 });
      } else if (k === 8) {
        resultat(x, y, c.w);
      } else {
        const centre = (k === 0 || k === 1 || k === 2 || k === 7);
        doc.fillColor("#000").font("Helvetica").fontSize(7).text(cells[k] || "", x + 2, y + 4, { width: c.w - 4, align: centre ? "center" : "left" });
      }
      x += c.w;
    }
    y += h;
  });
  pied();
}

module.exports = { genererFicheAppel };
