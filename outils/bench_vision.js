#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Banc d'essai des modeles de vision sur une fiche d'appel.
//
// Usage (dans le conteneur, une fois le PDF telecharge dans /app/downloads) :
//   node outils/bench_vision.js /app/downloads/<fichier>.pdf \
//        z-ai/glm-5.3-flash google/gemini-2.5-flash-lite google/gemini-2.5-flash
//
// Pour chaque modele : nb de lignes lues, telephones valides, codes mappes
// (non ambigus), duree. Sert a choisir le modele le moins cher qui lit bien.
// ---------------------------------------------------------------------------

require("dotenv").config();
const { extraireFeuilleAppel } = require("../odoo/import_appels");
const { normaliserTelephone, telephoneValide, analyserResultat } = require("../coeur/referentiel");

const chemin = process.argv[2];
const modeles = process.argv.slice(3);

if (!chemin || !modeles.length) {
  console.error("usage: node outils/bench_vision.js <chemin_pdf_ou_image> <modele1> [modele2] ...");
  process.exit(1);
}

function stats(extraction) {
  const lignes = (extraction && extraction.lignes) || [];
  let telOk = 0, mappes = 0, ambigus = 0;
  for (const l of lignes) {
    if (telephoneValide(normaliserTelephone(l.telephone))) telOk += 1;
    const r = analyserResultat(l.code_resultat, l.commentaire);
    if (r.statut === "ok") mappes += 1;
    else if (r.statut === "ambigu") ambigus += 1;
  }
  return { lignes: lignes.length, telOk, mappes, ambigus, agent: extraction && extraction.agent, date: extraction && extraction.date_appels };
}

(async () => {
  for (const modele of modeles) {
    process.env.IA_MODELE_VISION = modele;
    // Recharge le module ia (il fige le modele au require).
    delete require.cache[require.resolve("../ia")];
    delete require.cache[require.resolve("../odoo/import_appels")];
    const { extraireFeuilleAppel: extraire } = require("../odoo/import_appels");

    const t0 = Date.now();
    let s, err = null;
    try {
      const ex = await extraire(chemin);
      s = stats(ex);
    } catch (e) {
      err = e.message;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (err) console.log(`${modele.padEnd(34)} ECHEC (${dt}s) : ${err}`);
    else console.log(`${modele.padEnd(34)} ${dt}s | lignes=${s.lignes} tel_ok=${s.telOk} mappes=${s.mappes} ambigus=${s.ambigus} | agent=${s.agent} date=${s.date}`);
  }
})();
