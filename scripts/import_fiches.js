#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BACKDOOR d'import en MASSE (hors Lark).
//
// Traite tous les PDF/images d'un dossier avec EXACTEMENT le meme pipeline que
// le bot : routage (reception/appel) -> OCR -> classement (codes maison + jev)
// -> plan -> ecriture Odoo. Pratique pour un rattrapage de plusieurs fiches
// d'un coup, sans les envoyer une a une dans Lark. Le flux Lark normal reste
// inchange.
//
//   node scripts/import_fiches.js <dossier> [--go] [--only <texte>]
//
//   (defaut)   DRY-RUN : lit tout et affiche le plan, N'ECRIT RIEN.
//   --go       ecrit reellement dans Odoo (pistes + evenements + activites).
//   --only X   ne traite que les fichiers dont le nom contient X.
//
// A lancer la ou Node + poppler (pdftoppm) + les variables d'env
// (OPENROUTER_API_KEY, acces Odoo) sont disponibles. Le plus simple : DANS le
// conteneur du bot (tout y est deja), ex :
//   docker exec <ctn> node /app/scripts/import_fiches.js /app/downloads --only gloria
// L'anti-doublon (ocr_hash + telephone, table appels) saute les lignes deja
// importees : relancer est sans risque de doublon.
// ---------------------------------------------------------------------------

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { extraireFeuilleAppel, construirePlan, resumePlan, executerPlan } = require("../odoo/import_appels");
const { extraireFicheReception, construirePlanRelance, resumePlanRelance } = require("../odoo/import_relance");

// Meme routage que coeur/agent.js.
function typeParIndice(indice) {
  const t = (indice || "").toLowerCase();
  if (/commerc|r[eé]cept|relance|rapport|marie|sharone/.test(t)) return "reception";
  return "appel";
}
function sha256(chemin) {
  return crypto.createHash("sha256").update(fs.readFileSync(chemin)).digest("hex");
}

// Produit { kind: 'relance'|'appel', plan } pour un fichier, en reprenant la
// logique de routage de l'agent (reception, feuille de relance imprimee, fiche
// d'appel manuscrite).
async function planifier(chemin) {
  const indice = path.basename(chemin).replace(/^\d+-/, "");
  if (typeParIndice(indice) === "reception") {
    const ex = await extraireFicheReception(chemin);
    if (ex && ex.type_fiche === "reception" && Array.isArray(ex.lignes) && ex.lignes.length) {
      if (!ex.hash) ex.hash = sha256(chemin);
      return { kind: "relance", plan: await construirePlanRelance(ex, indice) };
    }
  }
  const extraction = await extraireFeuilleAppel(chemin);
  if (!extraction || !Array.isArray(extraction.lignes) || !extraction.lignes.length) return null;
  if (!extraction.hash) extraction.hash = sha256(chemin);
  if (extraction.est_feuille_relance_imprimee) {
    const exRelance = {
      agent: extraction.agent,
      hash: extraction.hash,
      lignes: extraction.lignes.map((l, i) => ({
        nom: l.nom || "",
        telephone: l.telephone,
        commentaire: l.commentaire || "",
        resultat: l.code_resultat || "",
        date_rdv: l.rdv_texte || "",
        date_session_brut: extraction.date_appels_brut || "",
        _page: l._page || null,
        _rang: l._rang || i + 1,
      })),
    };
    return { kind: "relance", plan: await construirePlanRelance(exRelance, indice) };
  }
  return { kind: "appel", plan: await construirePlan(extraction, indice) };
}

function indenter(texte) {
  return String(texte || "").split("\n").map((l) => "  " + l).join("\n");
}

(async () => {
  const raw = process.argv.slice(2);
  let dossier = null, only = null, go = false;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--go") go = true;
    else if (a === "--only") only = (raw[++i] || "").toLowerCase();
    else if (!a.startsWith("--") && !dossier) dossier = a;
  }
  if (!dossier) {
    console.error("Usage: node scripts/import_fiches.js <dossier> [--go] [--only <texte>]");
    process.exit(1);
  }

  let fichiers = fs.readdirSync(dossier).filter((f) => /\.(pdf|png|jpe?g|webp)$/i.test(f));
  if (only) fichiers = fichiers.filter((f) => f.toLowerCase().includes(only));
  if (!fichiers.length) {
    console.log("Aucun fichier a traiter dans", dossier, only ? `(filtre: ${only})` : "");
    return;
  }

  console.log(`${go ? "⚠️  IMPORT REEL (--go) : ecriture dans Odoo" : "DRY-RUN : lecture seule, RIEN n'est ecrit"} — ${fichiers.length} fichier(s)\n`);
  const total = { fiches: 0, actions: 0, pistes: 0, evenements: 0, activites: 0, deja: 0, echecs: 0, ignores: 0 };

  for (const f of fichiers) {
    const chemin = path.join(dossier, f);
    console.log(`\n=== ${f} ===`);
    let r;
    try {
      r = await planifier(chemin);
    } catch (e) {
      console.log("  ❌ extraction:", e.message);
      total.echecs++;
      continue;
    }
    if (!r) {
      console.log("  (ignore : aucune ligne exploitable)");
      total.ignores++;
      continue;
    }
    total.fiches++;
    total.actions += (r.plan.actions || []).length;
    console.log(indenter(r.kind === "relance" ? resumePlanRelance(r.plan) : resumePlan(r.plan)));

    // Fiche d'appel sans en-tete lisible (agent/date) : on N'ECRIT PAS (donnees
    // mal datees). A corriger via le nom de fichier (ex "Fiche Ben 22-09-26").
    if (go && r.kind === "appel" && r.plan.besoin_entete) {
      console.log("  ⏭️  non ecrite : en-tete (agent/date) manquante — renomme le fichier ou passe par Lark.");
      continue;
    }
    if (go) {
      const res = await executerPlan(r.plan);
      total.pistes += res.pistes_creees;
      total.evenements += res.evenements;
      total.activites += res.activites;
      total.deja += res.deja_synced;
      total.echecs += res.echecs.length;
      console.log(`  ✅ ecrit : ${res.pistes_creees} pistes, ${res.evenements} evenements, ${res.activites} activites, ${res.deja_synced} deja-faites, ${res.echecs.length} echecs`);
      if (res.echecs.length) console.log("     ", JSON.stringify(res.echecs.slice(0, 5)));
    }
  }

  console.log(
    `\n===== TOTAL : ${total.fiches} fiches, ${total.actions} lignes, ${total.ignores} ignorees` +
    (go ? ` | ECRIT : ${total.pistes} pistes, ${total.evenements} evenements, ${total.activites} activites, ${total.deja} deja, ${total.echecs} echecs` : " — DRY-RUN") +
    " ====="
  );
  if (!go) console.log("Ajoute --go pour ecrire reellement dans Odoo.");
})().catch((e) => {
  console.error("Erreur fatale:", e.message);
  process.exit(1);
});
