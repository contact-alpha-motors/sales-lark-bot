const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { creer, rechercherLire, uid } = require("./rpc");

// ir.model id d'un modele (mail.activity exige res_model_id, pas la chaine).
let _idCrmLead = null;
async function modeleId(technique) {
  if (technique === "crm.lead" && _idCrmLead) return _idCrmLead;
  const m = await rechercherLire("ir.model", [["model", "=", technique]], ["id"], { limit: 1 });
  const id = m.length ? m[0].id : null;
  if (technique === "crm.lead") _idCrmLead = id;
  return id;
}
const { enregistrerOcr, lireOcr, enregistrerAppel, mirrorLeads, trouverAppelSynced, marquerActiviteFaite,
  appelDejaEnregistre, listerEnAttente, marquerSynced, marquerErreurSync } = require("../memoire/base");

// Odoo injoignable : on stoppe proprement une synchro sans casser (mode degrade).
function estErreurOdoo(e) {
  return /Odoo HTTP|Odoo:|ECONN|ETIMEDOUT|timeout|530|50[234]/i.test((e && e.message) || "");
}

// Cree l'activite de suivi (RDV/rappel) d'une ligne. Champs obligatoires Odoo :
// res_model_id (id ir.model), res_id, date_deadline, user_id.
async function creerActivite(leadId, a, plan) {
  return creer("mail.activity", {
    res_model_id: await modeleId("crm.lead"),
    res_id: leadId,
    activity_type_id: TYPE_ACTIVITE_RDV,
    date_deadline: a.rdv.date,
    summary: a.rdv.resume,
    user_id: a.agent_id || plan.agent_id || (await uid()),
  });
}
const { chercherParTelephone, resoudreUtilisateur } = require("./requetes");
const { normaliserTelephone, telephoneValide, analyserResultat, detecterAgent, detecterDate } = require("../coeur/referentiel");
const { extraireFichierJson } = require("../ia");
const { disponible: popplerDispo, pdfEnImages, nettoyer } = require("../documents/pdf_en_images");

// ---------------------------------------------------------------------------
// Import d'une fiche d'appel scannee vers Odoo (ecriture directe).
//
// Chaque ligne d'appel donne : une piste (retrouvee ou creee), un evenement
// dealership.event.log, et une activite si c'est un RDV date. Mode sur : les
// codes ambigus (PP/OUI) et les demandes DP/DE ne sont PAS ecrits, juste
// listes. Rien ne part avant le "oui" de l'utilisateur.
// ---------------------------------------------------------------------------

const TYPE_ACTIVITE_RDV = Number(process.env.ODOO_ACTIVITY_MEETING_ID || 3); // "Meeting"

// Instruction par PAGE : on extrait chaque page separement (un seul appel de
// vision par image, en parallele). Bien plus rapide et robuste qu'un seul
// appel avec 5 images — qui faisait expirer le modele.
const INSTRUCTION_PAGE = `Ceci est UNE page d'une FICHE D'APPEL manuscrite d'Alpha Motors (concession auto).
L'EN-TETE de page donne l'agent qui a passe les appels et la date. Chaque LIGNE du tableau = un appel a un prospect.
C'est une liste de RE-LANCE : chaque ligne est un prospect deja contacte avant. La colonne "personne ayant appele" est l'agent qui a appele LA FOIS PRECEDENTE (historique), avec la date et le resultat de ce contact precedent. Le resultat de l'appel ACTUEL est le code manuscrit du jour.
Renvoie UNIQUEMENT du JSON, cette forme exacte :
{
  "agent": "<nom en en-tete de page, ou ''>",
  "date_appels_brut": "<texte brut de la date en en-tete, ex '22/09/26', ou ''>",
  "lignes": [
    {
      "nom": "<nom du prospect ou ''>",
      "telephone": "<chiffres du numero>",
      "appelant_precedent": "<nom de la personne ayant appele la fois precedente, ou ''>",
      "date_derniere_action": "<date du dernier contact precedent, ou ''>",
      "statut_precedent": "<resultat de la derniere action / statut imprime, ou ''>",
      "code_resultat": "<le code manuscrit du resultat de l'appel ACTUEL: PP, PI, NR, NRP, RDV, BL, OUI, PL...>",
      "commentaire": "<le commentaire manuscrit ou ''>",
      "rdv_texte": "<date/heure de RDV si mentionnee, sinon ''>",
      "vehicule": "<vehicule si mentionne ou ''>"
    }
  ]
}
Lis TOUTES les lignes de CETTE page. Ne corrige pas les numeros. Info absente = chaine vide.`;

function fusionnerPages(pages) {
  const ok = pages.filter(Boolean);
  const entete = ok.find((p) => p.agent) || {};
  return {
    agent: entete.agent || "",
    date_appels_brut: entete.date_appels_brut || "",
    lignes: ok.flatMap((p) => p.lignes || []),
  };
}

// Extraction : un PDF est rasterise (poppler) puis chaque page est lue en
// parallele. Une image seule est lue directement. Une page qui echoue est
// simplement ignoree, le reste de la fiche passe quand meme.
async function extraireFeuilleAppel(chemin) {
  // Cache par empreinte du fichier : on ne relit jamais deux fois le meme
  // scan (economie), et chaque lecture alimente le corpus ocr_cache.
  const octets = fs.readFileSync(chemin);
  const hash = crypto.createHash("sha256").update(octets).digest("hex");
  const cache = lireOcr(hash);
  if (cache) {
    console.log(`[ocr] cache hit ${hash.slice(0, 8)} (${cache.nb_lignes} lignes, 0 cout)`);
    try { const r = JSON.parse(cache.extraction); r.hash = hash; return r; } catch { /* cache corrompu -> relire */ }
  }

  // Dossier persistant du corpus : on garde les images (pages) a cote du JSON,
  // pour reentrainer/ameliorer la lecture d'ecriture plus tard.
  const corpusDir = path.join(process.env.OCR_IMAGES_DIR || path.join(__dirname, "..", "data", "ocr_images"), hash);

  let resultat;
  const ext = path.extname(chemin).toLowerCase();
  if (ext === ".pdf" && (await popplerDispo())) {
    const { images, dossier } = await pdfEnImages(chemin);
    try {
      const pages = await Promise.all(
        images.map((img) => extraireFichierJson(INSTRUCTION_PAGE, img).catch(() => null))
      );
      resultat = fusionnerPages(pages);
      archiverImages(corpusDir, images);
    } finally {
      nettoyer(dossier);
    }
  } else {
    resultat = await extraireFichierJson(INSTRUCTION_PAGE, chemin);
    archiverImages(corpusDir, [chemin]);
  }

  if (resultat) resultat.hash = hash;
  try {
    enregistrerOcr({
      hash,
      fichier: path.basename(chemin).replace(/^\d+-/, ""),
      extraction: JSON.stringify(resultat || {}),
      modele: process.env.IA_MODELE_VISION || "",
      nb_lignes: resultat && resultat.lignes ? resultat.lignes.length : 0,
    });
  } catch (e) {
    console.error("[ocr] ecriture cache:", e.message);
  }

  return resultat;
}

// Copie les pages rasterisees dans le corpus persistant (best effort : ne doit
// jamais casser l'import si le disque refuse).
function archiverImages(dossierCible, images) {
  try {
    fs.mkdirSync(dossierCible, { recursive: true });
    images.forEach((img, i) => {
      const ext = path.extname(img) || ".png";
      fs.copyFileSync(img, path.join(dossierCible, `page-${String(i + 1).padStart(2, "0")}${ext}`));
    });
  } catch (e) {
    console.error("[ocr] archivage images:", e.message);
  }
}

// Trouve (ou cree une fois) une etiquette crm.tag et renvoie son id.
const cacheTags = {};
async function resoudreTag(nom) {
  if (cacheTags[nom]) return cacheTags[nom];
  const trouve = await rechercherLire("crm.tag", [["name", "=ilike", nom]], ["id"], { limit: 1 });
  const id = trouve.length ? trouve[0].id : await creer("crm.tag", { name: nom });
  cacheTags[nom] = id;
  return id;
}

// Delegue au resolveur robuste (gere "MARIE-SHARONE", tokens distinctifs, cache).
const resoudreAgent = resoudreUtilisateur;

function parserDateRdv(texte, anneeDefaut) {
  const m = String(texte || "").match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (!m) return null;
  const jour = Number(m[1]);
  const mois = Number(m[2]);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  let annee = anneeDefaut;
  if (m[3]) annee = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${annee}-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`;
}

// Construit le plan sans rien ecrire : pour chaque ligne, decide creer/retrouver
// la piste, le sous-type d'evenement, et une activite eventuelle.
async function construirePlan(extraction, indice = "") {
  // Agent + date : d'abord l'indice (nom de fichier / legende, ex.
  // "Fiche Ben 22 septembre"), fiable ; sinon l'en-tete de page, souvent
  // absent ou mal lu. Si rien -> besoin_entete, on demandera a l'utilisateur.
  const agentNom = detecterAgent(indice) || detecterAgent(extraction.agent);
  const dateAppels = detecterDate(indice) || detecterDate(extraction.date_appels_brut);
  const agentUser = agentNom ? await resoudreAgent(agentNom) : null;
  const anneeDefaut = dateAppels ? Number(dateAppels.slice(0, 4)) : 2026;

  const plan = {
    ocr_hash: extraction.hash || null,
    agent: agentNom || extraction.agent || null,
    agent_id: agentUser ? agentUser.id : null,
    date_appels: dateAppels,
    event_date: dateAppels ? `${dateAppels} 12:00:00` : null,
    besoin_entete: !agentNom || !dateAppels,
    actions: [],
    ambigus: [],
    routage: [],
    invalides: [],
  };

  for (const ligne of extraction.lignes || []) {
    const tel = normaliserTelephone(ligne.telephone);
    const res = analyserResultat(ligne.code_resultat, ligne.commentaire);

    if (res.statut === "routage") {
      plan.routage.push({ nom: ligne.nom, telephone: tel, motif: res.note, code: res.canon });
      continue;
    }
    if (res.statut === "ambigu") {
      plan.ambigus.push({ nom: ligne.nom, telephone: tel, code: res.canon, commentaire: ligne.commentaire });
      continue;
    }
    if (!telephoneValide(tel)) {
      plan.invalides.push({ nom: ligne.nom, telephone: ligne.telephone, raison: "numero manquant/invalide" });
      continue;
    }

    // Dedup : piste existante par telephone ?
    const existantes = await chercherParTelephone(tel);
    const piste = existantes[0] || null;

    // Contexte du contact PRECEDENT (liste de relance) -> garde comme historique.
    const prec = [];
    if (ligne.appelant_precedent) prec.push(`par ${ligne.appelant_precedent}`);
    if (ligne.date_derniere_action) prec.push(`le ${ligne.date_derniere_action}`);
    if (ligne.statut_precedent) prec.push(`resultat ${ligne.statut_precedent}`);
    const precedent = prec.length ? `Precedent: ${prec.join(" ")}` : "";

    const notes = [
      ligne.commentaire || "",
      res.note ? `[${res.note}]` : "",
      ligne.vehicule ? `Vehicule: ${ligne.vehicule}` : "",
      precedent,
      `(fiche ${plan.agent || "?"} ${plan.date_appels || ""})`,
    ].filter(Boolean).join(" ").trim();

    const action = {
      nom: (ligne.nom || "").trim(),
      telephone: tel,
      piste_id: piste ? piste.id : null,
      piste_nom: piste ? piste.contact_name || piste.name : null,
      nouvelle_piste: !piste,
      event_type: res.event_type,
      sous_type: res.sous_type,
      canon: res.canon,
      tag: res.tag || null,
      notes,
      rdv: null,
    };

    // Activite si RDV avec une date exploitable.
    if ((res.sous_type === "meeting_booked" || res.sous_type === "video_meeting_booked")) {
      const dateRdv = parserDateRdv(ligne.rdv_texte || ligne.commentaire, anneeDefaut);
      if (dateRdv) {
        action.rdv = { date: dateRdv, resume: `RDV: ${action.nom || tel}${ligne.vehicule ? ` - ${ligne.vehicule}` : ""}` };
      }
    }

    plan.actions.push(action);
  }

  plan.resume = {
    total_lignes: (extraction.lignes || []).length,
    a_ecrire: plan.actions.length,
    nouvelles_pistes: plan.actions.filter((a) => a.nouvelle_piste).length,
    rdv: plan.actions.filter((a) => a.rdv).length,
    ambigus: plan.ambigus.length,
    routage: plan.routage.length,
    invalides: plan.invalides.length,
  };

  return plan;
}

// Complete l'en-tete manquante d'un plan a partir d'un texte utilisateur
// (ex. "Ben 22/09/26"), sans re-extraire la fiche. Renvoie true si complet.
async function completerEntete(plan, texte) {
  const agentNom = detecterAgent(texte);
  const date = detecterDate(texte);
  if (agentNom) {
    const u = await resoudreAgent(agentNom);
    plan.agent = agentNom;
    plan.agent_id = u ? u.id : null;
  }
  if (date) {
    plan.date_appels = date;
    plan.event_date = `${date} 12:00:00`;
  }
  plan.besoin_entete = !plan.agent || !plan.date_appels;
  return !plan.besoin_entete;
}

// Ecrit UNE action dans Odoo (piste + evenement + activite eventuelle). Isolee :
// une ligne qui echoue n'emporte pas le reste. `ctx` = contexte du plan
// (ocr_hash, agent_id, event_date par defaut). Renvoie l'etat + les ids Odoo.
// Cumule les compteurs dans `resultat`.
async function ecrireActionOdoo(a, ctx, resultat) {
  // --- Garde-fou idempotence : ligne (meme scan + tel) deja synchronisee ? ---
  const dejaSync = trouverAppelSynced(ctx.ocr_hash, a.telephone);
  if (dejaSync) {
    resultat.deja_synced += 1;
    let activiteOk = dejaSync.activite_ok;
    // On NE recree PAS piste+evenement. On rattrape seulement une activite
    // manquante (RDV/rappel) si elle n'a pas encore ete creee (backfill).
    if (a.rdv && !dejaSync.activite_ok && dejaSync.odoo_lead_id) {
      try {
        await creerActivite(dejaSync.odoo_lead_id, a, ctx);
        marquerActiviteFaite(dejaSync.id);
        resultat.activites += 1;
        activiteOk = 1;
      } catch (e) {
        resultat.echecs.push({ telephone: a.telephone, etape: "activite(backfill)", erreur: e.message });
      }
    }
    return { skip: true, etat: "synced", leadId: dejaSync.odoo_lead_id, eventId: null, activiteOk };
  }

  let leadId = a.piste_id;
  let eventId = null;
  let etat = "synced";
  let err = null;
  let activiteOk = 0;
  try {
    if (!leadId) {
      leadId = await creer("crm.lead", {
        name: a.nom || `Prospect ${a.telephone}`,
        contact_name: a.nom || undefined,
        phone: a.telephone,
        type: "lead",
      });
      resultat.pistes_creees += 1;
      mirrorLeads([{ id: leadId, name: a.nom, contact_name: a.nom, phone: a.telephone, type: "lead" }]);
    }

    const evenement = {
      event_type: a.event_type,
      lead_id: leadId,
      event_date: a.event_date || ctx.event_date,
      contact_phone: a.telephone,
      notes: a.notes,
    };
    if (a.sous_type) evenement.sub_type = a.sous_type; // null = non categorise
    const agentEvt = a.agent_id || ctx.agent_id;
    if (agentEvt) evenement.user_id = agentEvt;
    if (a.tag) {
      const tagId = await resoudreTag(a.tag);
      evenement.tag_ids = [[6, 0, [tagId]]];
    }
    eventId = await creer("dealership.event.log", evenement);
    resultat.evenements += 1;

    if (a.rdv) {
      try {
        await creerActivite(leadId, a, ctx);
        resultat.activites += 1;
        activiteOk = 1;
      } catch (e) {
        // L'activite est un bonus : son echec ne perd pas l'evenement.
        resultat.echecs.push({ telephone: a.telephone, etape: "activite", erreur: e.message });
      }
    }
  } catch (e) {
    etat = "error";
    err = e.message;
    resultat.echecs.push({ telephone: a.telephone, etape: "evenement", erreur: e.message });
  }
  return { skip: false, etat, err, leadId: leadId || null, eventId, activiteOk };
}

// Ecrit le plan directement dans Odoo (chemin historique). Chaque ligne trace
// son etat de synchro dans l'entrepot local.
async function executerPlan(plan) {
  const resultat = { pistes_creees: 0, evenements: 0, activites: 0, deja_synced: 0, echecs: [] };
  const ctx = { ocr_hash: plan.ocr_hash, agent: plan.agent, agent_id: plan.agent_id || null, event_date: plan.event_date || null };

  for (const a of plan.actions) {
    const res = await ecrireActionOdoo(a, ctx, resultat);
    if (res.skip) continue;
    try {
      enregistrerAppel({
        ocr_hash: plan.ocr_hash, agent: a.agent_nom || plan.agent, date_appel: plan.date_appels,
        telephone: a.telephone, nom: a.nom, code: a.canon, sous_type: a.sous_type,
        commentaire: a.notes, sync_state: res.etat, odoo_lead_id: res.leadId,
        odoo_event_id: res.eventId, rdv_date: a.rdv ? a.rdv.date : null, activite_ok: res.activiteOk, sync_error: res.err,
      });
    } catch (e2) {
      console.error("[appels] enregistrement local:", e2.message);
    }
  }
  return resultat;
}

// --- Modele "garde d'abord, synchronise a la demande" ---------------------

// Garde le plan en LOCAL (aucune ecriture Odoo). Chaque ligne porte son
// contexte (payload) pour etre poussee plus tard, en tout ou en partie.
function stagerPlan(plan) {
  let stagees = 0, deja = 0;
  const ctx = { ocr_hash: plan.ocr_hash, agent: plan.agent, agent_id: plan.agent_id || null, event_date: plan.event_date || null };
  for (const a of plan.actions) {
    if (appelDejaEnregistre(plan.ocr_hash, a.telephone)) { deja += 1; continue; }
    const dateLigne = String(a.event_date || plan.event_date || "").slice(0, 10) || plan.date_appels || null;
    try {
      enregistrerAppel({
        ocr_hash: plan.ocr_hash, agent: a.agent_nom || plan.agent, date_appel: dateLigne,
        telephone: a.telephone, nom: a.nom, code: a.canon || null, sous_type: a.sous_type,
        commentaire: a.notes, rdv_date: a.rdv ? a.rdv.date : null,
        payload: JSON.stringify({ action: a, ctx }), sync_state: "local",
      });
      stagees += 1;
    } catch (e) {
      console.error("[appels] stage local:", e.message);
    }
  }
  return { stagees, deja, resume: plan.resume };
}

// Pousse vers Odoo les lignes gardees en local (filtres facultatifs : agent,
// fiche/hash, date, telephone). Odoo injoignable -> on s'arrete proprement,
// les lignes non poussees restent 'local' (on relancera plus tard).
async function synchroniser(filtre = {}) {
  const rows = listerEnAttente(filtre);
  const resultat = { total: rows.length, synced: 0, pistes_creees: 0, evenements: 0, activites: 0, deja_synced: 0, echecs: [], interrompu: false };

  for (const row of rows) {
    const p = row.payload;
    if (!p || !p.action) {
      marquerErreurSync(row.id, "payload manquant (ligne trop ancienne)");
      resultat.echecs.push({ id: row.id, telephone: row.telephone, erreur: "payload manquant" });
      continue;
    }
    let res;
    try {
      res = await ecrireActionOdoo(p.action, p.ctx || {}, resultat);
    } catch (e) {
      if (estErreurOdoo(e)) { resultat.interrompu = true; break; } // Odoo down : on garde le reste en local
      marquerErreurSync(row.id, e.message);
      resultat.echecs.push({ id: row.id, telephone: row.telephone, erreur: e.message });
      continue;
    }
    if (res.etat === "error") {
      marquerErreurSync(row.id, res.err);
    } else {
      marquerSynced(row.id, { odoo_lead_id: res.leadId, odoo_event_id: res.eventId, activite_ok: res.activiteOk ? 1 : 0 });
      resultat.synced += 1;
    }
  }
  return resultat;
}

function resumePlan(plan) {
  const r = plan.resume;
  const lignes = [
    `Fiche d'appel${plan.agent ? ` de ${plan.agent}` : ""}${plan.date_appels ? ` (${plan.date_appels})` : ""} :`,
    `- ${r.total_lignes} lignes lues`,
    `- ${r.a_ecrire} appels a enregistrer, dont ${r.nouvelles_pistes} nouvelles pistes et ${r.rdv} RDV`,
  ];
  if (r.ambigus) lignes.push(`- ${r.ambigus} codes ambigus (PP/OUI/inconnu) NON importes`);
  if (r.routage) lignes.push(`- ${r.routage} demandes hors-commercial (DP/DE/SAV) NON importees`);
  if (r.invalides) lignes.push(`- ${r.invalides} numeros invalides ignores`);

  // En-tete manquante : on ne propose pas d'ecrire, on demande agent + date.
  if (plan.besoin_entete) {
    const manque = [!plan.agent && "l'agent (Astride, Gloria ou Ben)", !plan.date_appels && "la date"].filter(Boolean).join(" et ");
    lignes.push("", `Il me manque ${manque} : cette fiche n'a pas d'en-tete lisible. Reponds par exemple « Ben 22/09/26 » et je te montre le recap avant d'ecrire.`);
    return lignes.join("\n");
  }

  if (!plan.agent_id) lignes.push(`- ATTENTION : agent "${plan.agent}" non retrouve dans Odoo, appels non attribues`);
  lignes.push("", 'J\'enregistre tout ca dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return lignes.join("\n");
}

module.exports = { extraireFeuilleAppel, construirePlan, executerPlan, resumePlan, completerEntete, stagerPlan, synchroniser };
