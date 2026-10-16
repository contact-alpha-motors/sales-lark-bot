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
//   node scripts/import_fiches.js <dossier> [--go] [--only <texte>] [--stage-only]
//   node scripts/import_fiches.js --sync-only
//
//   (defaut)      DRY-RUN : lit tout et affiche le plan, N'ECRIT NI NE GARDE RIEN.
//   --go          GARDE les lignes en local, puis les POUSSE dans Odoo.
//   --stage-only  garde en local sans pousser (pousse plus tard).
//   --sync-only   ne lit aucune fiche : pousse seulement ce qui est deja garde
//                 en local (pour REPRENDRE apres qu'Odoo soit revenu).
//   --only X      ne traite que les fichiers dont le nom contient X.
//
// RESILIENCE (comme le bot) : --go garde d'abord tout en local (toujours, sans
// Odoo), puis synchronise. Si Odoo est injoignable, la synchro s'arrete
// proprement et le reste RESTE en local — relance « --sync-only » (ou
// « synchronise tout » dans Lark) quand Odoo revient. Meme cache local que le
// bot : rien n'est perdu, rien n'est duplique (anti-doublon ocr_hash+telephone).
//
// A lancer la ou Node + poppler (pdftoppm) + les variables d'env
// (OPENROUTER_API_KEY, acces Odoo) sont disponibles. Le plus simple : DANS le
// conteneur du bot (tout y est deja), ex :
//   docker exec <ctn> node /app/scripts/import_fiches.js /app/downloads --only gloria
// ---------------------------------------------------------------------------

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { extraireFeuilleAppel, construirePlan, resumePlan, stagerPlan, synchroniser } = require("../odoo/import_appels");
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

// Pousse ce qui est garde en local vers Odoo, avec un compte-rendu lisible et
// resilient (Odoo down -> on garde le reste).
async function pousser(label) {
  console.log(`\n— ${label} —`);
  const s = await synchroniser({});
  let msg = `Poussé : ${s.synced}/${s.total} ligne(s) — ${s.pistes_creees} pistes, ${s.evenements} evenements, ${s.activites} activites, ${s.deja_synced} deja`;
  if (s.echecs.length) msg += `, ${s.echecs.length} echecs`;
  console.log(msg);
  if (s.interrompu) {
    console.log("⚠️  Odoo injoignable : le reste est GARDÉ en local. Relance « node scripts/import_fiches.js --sync-only » (ou « synchronise tout » dans Lark) quand Odoo revient.");
  }
  if (s.echecs.length) console.log("   échecs:", JSON.stringify(s.echecs.slice(0, 5)));
  return s;
}

(async () => {
  const raw = process.argv.slice(2);
  let dossier = null, only = null, go = false, stageOnly = false, syncOnly = false;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--go") go = true;
    else if (a === "--stage-only") { go = true; stageOnly = true; }
    else if (a === "--sync-only") syncOnly = true;
    else if (a === "--only") only = (raw[++i] || "").toLowerCase();
    else if (!a.startsWith("--") && !dossier) dossier = a;
  }

  // Reprise pure : pousser ce qui attend deja en local (apres qu'Odoo soit revenu).
  if (syncOnly) {
    await pousser("Synchronisation du cache local vers Odoo");
    return;
  }

  if (!dossier) {
    console.error("Usage: node scripts/import_fiches.js <dossier> [--go] [--only <texte>] [--stage-only]\n       node scripts/import_fiches.js --sync-only");
    process.exit(1);
  }

  let fichiers = fs.readdirSync(dossier).filter((f) => /\.(pdf|png|jpe?g|webp)$/i.test(f));
  if (only) fichiers = fichiers.filter((f) => f.toLowerCase().includes(only));
  if (!fichiers.length) {
    console.log("Aucun fichier a traiter dans", dossier, only ? `(filtre: ${only})` : "");
    return;
  }

  const mode = stageOnly ? "GARDE EN LOCAL (--stage-only)" : go ? "GARDE EN LOCAL puis SYNCHRONISE (--go)" : "DRY-RUN : lecture seule, RIEN n'est gardé";
  console.log(`${mode} — ${fichiers.length} fichier(s)\n`);
  const total = { fiches: 0, actions: 0, stagees: 0, deja: 0, ignores: 0, echecs: 0 };

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

    // Fiche d'appel sans en-tete lisible (agent/date) : on NE GARDE PAS (donnees
    // mal datees). A corriger via le nom de fichier (ex "Fiche Ben 22-09-26").
    if (go && r.kind === "appel" && r.plan.besoin_entete) {
      console.log("  ⏭️  non gardée : en-tete (agent/date) manquante — renomme le fichier (ex « Fiche Ben 22-09-26 ») ou passe par Lark.");
      continue;
    }
    if (go) {
      const s = stagerPlan(r.plan);
      total.stagees += s.stagees;
      total.deja += s.deja;
      console.log(`  📥 gardé en local : ${s.stagees} ligne(s)${s.deja ? ` (${s.deja} déjà gardées)` : ""}`);
    }
  }

  console.log(
    `\n===== TOTAL : ${total.fiches} fiches, ${total.actions} lignes, ${total.ignores} ignorées` +
    (go ? ` | GARDÉ : ${total.stagees} (${total.deja} déjà)` : " — DRY-RUN") +
    " ====="
  );

  if (!go) { console.log("Ajoute --go pour garder en local + synchroniser (ou --stage-only pour garder sans pousser)."); return; }
  if (stageOnly) { console.log("Gardé en local. Lance « --sync-only » (ou « synchronise tout » dans Lark) pour pousser dans Odoo."); return; }

  // --go : on pousse ce qui vient d'etre garde (resilient si Odoo down).
  await pousser("Synchronisation vers Odoo");
})().catch((e) => {
  console.error("Erreur fatale:", e.message);
  process.exit(1);
});
