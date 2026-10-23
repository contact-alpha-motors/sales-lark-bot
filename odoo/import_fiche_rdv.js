const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { normaliserTelephone, telephoneValide, detecterDate } = require("../coeur/referentiel");
const { chercherParTelephone } = require("./requetes");
const { STATUT_APPEL } = require("./import_appels");
const { extraireFichierJson } = require("../ia");
const { lireOcr, enregistrerOcr } = require("../memoire/base");

// ---------------------------------------------------------------------------
// SCAN-RETOUR des fiches d'appels branded (RDV du jour / lapins).
//
// Le commercial coche une case "Resultat de l'appel" et ecrit eventuellement
// une date (RDV (re)fixe / rappel) + des notes. On relit tout ca et on prepare
// l'ecriture Odoo (evenement + statut + activite), via le MEME circuit resilient
// que les autres imports (stagerPlan -> synchroniser).
//
// NOTE : la detection des cases cochees sur une photo de feuille imprimee doit
// etre CALIBREE sur de vraies fiches remplies. L'instruction ci-dessous est le
// point de depart ; a ajuster apres les premiers scans reels.
// ---------------------------------------------------------------------------

const INSTRUCTION = `Ceci est une "FICHE D'APPELS" ALPHA MOTORS (logo rouge en haut, tableau), REMPLIE a la main par un commercial.
Colonnes imprimees : N°, Heure du RDV, Appeler a, Client, Telephone, Vehicule, Agent, RDV pris le, "Resultat de l'appel" (des CASES A COCHER), Notes.
Dans "Resultat de l'appel", les options sont : "RDV confirme / fixe le __ a __h", "NRP", "Injoignable", "Pas interesse / Annule", "Rappeler le __".
Renvoie UNIQUEMENT du JSON, exactement :
{
  "est_fiche_rdv_appels": true si c'est bien cette fiche (titre "FICHE D'APPELS" + colonne "Resultat de l'appel" a cocher), sinon false,
  "lignes": [
    {
      "telephone": "<numero imprime de la colonne Telephone>",
      "client": "<nom imprime>",
      "resultat": "<la case COCHEE: 'rdv' si 'RDV confirme/fixe' est coche, 'nrp', 'injoignable', 'pas_interesse', 'rappel' ; '' si aucune case cochee>",
      "date_ecrite": "<date manuscrite ecrite a cote (fixe le / reprogramme / rappeler le), sinon ''>",
      "heure_ecrite": "<heure manuscrite si ecrite, sinon ''>",
      "notes": "<texte manuscrit de la colonne Notes, sinon ''>"
    }
  ]
}
Une case est COCHEE seulement si elle porte une croix, un coche ou une marque manuscrite. Si rien n'est coche sur une ligne, resultat="". Lis TOUTES les lignes du tableau. Ne corrige pas les numeros.`;

// Case cochee -> verdict Odoo. "rdv" depend d'une date ecrite (nouveau RDV) ou
// non (simple confirmation).
function verdictResultat(resultat, dateEcrite) {
  switch (String(resultat || "").toLowerCase()) {
    case "rdv":
      return dateEcrite
        ? { sous_type: "meeting_booked", event_type: "call", note: "RDV (re)fixe", rdv: true }
        : { sous_type: "meeting_confirmed", event_type: "call", note: "RDV confirme" };
    case "nrp": return { sous_type: "no_answer", event_type: "call" };
    case "injoignable": return { sous_type: "unreachable", event_type: "call" };
    case "pas_interesse": return { sous_type: "not_interested", event_type: "call", note: "Pas interesse / annule" };
    case "rappel": return { sous_type: "call_back", event_type: "call", note: "Rappel demande", rappel: true };
    default: return { sous_type: null, non_categorise: true }; // rien coche -> a revoir
  }
}

function aujourdhuiCmr() { return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10); }

async function extraireFicheRdv(chemin) {
  const octets = fs.readFileSync(chemin);
  const hash = crypto.createHash("sha256").update(octets).digest("hex");
  const visionActuel = process.env.IA_MODELE_VISION || "";
  const cache = lireOcr(hash);
  if (cache) {
    try {
      const r = JSON.parse(cache.extraction);
      if (r && "est_fiche_rdv_appels" in r && cache.modele === visionActuel) return r;
    } catch { /* relire */ }
  }
  const resultat = await extraireFichierJson(INSTRUCTION, chemin);
  if (resultat) resultat.hash = hash;
  if (resultat && resultat.est_fiche_rdv_appels) {
    try {
      enregistrerOcr({ hash, fichier: path.basename(chemin).replace(/^\d+-/, ""), extraction: JSON.stringify(resultat), modele: visionActuel, nb_lignes: (resultat.lignes || []).length });
    } catch (e) { console.error("[ocr] cache fiche rdv:", e.message); }
  }
  return resultat;
}

async function construirePlanFicheRdv(extraction, indice = "") {
  const dateAppel = detecterDate(indice) || aujourdhuiCmr();
  const plan = {
    type: "fiche_rdv",
    ocr_hash: extraction.hash || null,
    event_date: `${dateAppel} 12:00:00`,
    actions: [],
    vides: [],
    invalides: [],
    a_revoir: [],
  };

  for (const ligne of extraction.lignes || []) {
    const tel = normaliserTelephone(ligne.telephone);
    const res = ligne.resultat;
    if (!res && !telephoneValide(tel)) { plan.vides.push({ client: ligne.client }); continue; }
    if (!telephoneValide(tel)) { plan.invalides.push({ client: ligne.client, telephone: ligne.telephone }); continue; }

    const v = verdictResultat(res, ligne.date_ecrite);
    const existantes = await chercherParTelephone(tel).catch(() => []);
    const piste = existantes[0] || null;
    const dateFixee = v.rdv || v.rappel ? detecterDate(ligne.date_ecrite) : null;

    const notes = [ligne.notes || "", v.note ? `[${v.note}]` : "", "(scan fiche d'appels)"].filter(Boolean).join(" ").trim();
    const action = {
      nom: (ligne.client || "").trim(),
      telephone: tel,
      piste_id: piste ? piste.id : null,
      nouvelle_piste: !piste,
      event_type: v.event_type || "call",
      sous_type: v.sous_type,
      event_date: plan.event_date,
      agent_id: null,
      non_categorise: !!v.non_categorise,
      a_revoir: !!v.non_categorise,
      tags: null,
      notes,
      rdv: null,
      callback_date: null,
    };
    if (v.rdv && dateFixee) action.rdv = { date: dateFixee, resume: `RDV: ${action.nom || tel}`, type: "meeting" };
    if (v.rappel && dateFixee) { action.rdv = { date: dateFixee, resume: `Rappel: ${action.nom || tel}`, type: "callback" }; action.callback_date = dateFixee; }

    if (v.non_categorise) plan.a_revoir.push({ client: ligne.client, telephone: tel });
    plan.actions.push(action);
  }

  plan.resume = {
    total: (extraction.lignes || []).length,
    a_ecrire: plan.actions.length,
    rdv: plan.actions.filter((a) => a.sous_type === "meeting_booked" || a.sous_type === "meeting_confirmed").length,
    rappels: plan.actions.filter((a) => a.sous_type === "call_back").length,
    a_revoir: plan.a_revoir.length,
    invalides: plan.invalides.length,
  };
  return plan;
}

function resumePlanFicheRdv(plan) {
  const r = plan.resume;
  const l = [
    "Scan fiche d'appels :",
    `- ${r.total} lignes lues, ${r.a_ecrire} resultats a enregistrer`,
    `- ${r.rdv} RDV (confirmes/fixes), ${r.rappels} rappels`,
  ];
  if (r.a_revoir) l.push(`- 🔎 ${r.a_revoir} lignes sans case cochee (a revoir)`);
  if (r.invalides) l.push(`- ${r.invalides} numeros invalides ignores`);
  l.push("", 'J\'enregistre ces resultats dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return l.join("\n");
}

module.exports = { extraireFicheRdv, construirePlanFicheRdv, resumePlanFicheRdv };
