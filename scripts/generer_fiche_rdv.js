#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Genere une fiche d'appels (PDF branded) depuis Odoo EN DIRECT.
//
//   node scripts/generer_fiche_rdv.js jour   [AAAA-MM-JJ]            (defaut: aujourd'hui)
//   node scripts/generer_fiche_rdv.js lapins [debut] [fin]          (defaut: 2026-09-01 .. aujourd'hui)
//
// A lancer la ou les acces Odoo existent (le conteneur du bot). Lecture seule.
// ---------------------------------------------------------------------------
require("dotenv").config();
const { lignesRdvDuJour, lignesLapins, aujourdhuiCmr } = require("../odoo/fiches_rdv");
const { genererFicheAppel } = require("../documents/fiche_appel_pdf");

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
function enClair(iso) {
  const [a, m, j] = iso.split("-").map(Number);
  const jourSem = JOURS[new Date(Date.UTC(a, m - 1, j)).getUTCDay()];
  return `${jourSem} ${String(j).padStart(2, "0")}/${String(m).padStart(2, "0")}/${a}`;
}

(async () => {
  const [type, a1, a2] = process.argv.slice(2);
  if (type === "jour") {
    const date = a1 || aujourdhuiCmr();
    const lignes = await lignesRdvDuJour(date);
    const chemin = await genererFicheAppel({
      nomFichier: `Fiche_RDV_du_jour_${date}.pdf`,
      titre: "FICHE D'APPELS H-1 — RDV du jour (appeler 1 heure avant)",
      sousTitre: `RDV du ${enClair(date)}`,
      lignes,
    });
    console.log(`${lignes.length} RDV -> ${chemin}`);
  } else if (type === "lapins") {
    const debut = a1 || "2026-09-01";
    const fin = a2 || aujourdhuiCmr();
    const lignes = await lignesLapins(debut, fin);
    const chemin = await genererFicheAppel({
      nomFichier: `Fiche_RDV_non_honores_${debut}_${fin}.pdf`,
      titre: "FICHE D'APPELS — RDV non honorés (relance)",
      sousTitre: `Période du ${enClair(debut)} au ${enClair(fin)}`,
      lignes,
    });
    console.log(`${lignes.length} lapins -> ${chemin}`);
  } else {
    console.error("Usage: node scripts/generer_fiche_rdv.js jour [date] | lapins [debut] [fin]");
    process.exit(1);
  }
})().catch((e) => { console.error("Erreur:", e.message); process.exit(1); });
