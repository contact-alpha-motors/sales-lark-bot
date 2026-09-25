const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { rechercherLire } = require("./rpc");
const { chercherParTelephone } = require("./requetes");
const { normaliserTelephone, telephoneValide, detecterDate } = require("../coeur/referentiel");
const { extraireFichierJson } = require("../ia");
const { enregistrerOcr, lireOcr } = require("../memoire/base");
const { disponible: popplerDispo, pdfEnImages, nettoyer } = require("../documents/pdf_en_images");

function aujourdhuiCmr() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}
function archiverImages(dossierCible, images) {
  try {
    fs.mkdirSync(dossierCible, { recursive: true });
    images.forEach((img, i) => fs.copyFileSync(img, path.join(dossierCible, `page-${String(i + 1).padStart(2, "0")}.png`)));
  } catch (e) {
    console.error("[ocr] archivage images:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Import des fiches "RAPPORT DES RECEPTIONS CLIENTS — LISTE D'APPELS : <agent>"
// (un commercial relance par telephone d'anciennes receptions showroom).
//
// Tableau IMPRIME (nom, tel, date reception, vehicule, origine, agent) +
// COMMENTAIRE manuscrit qui porte le resultat. Une date de session peut etre
// griffonnee sur la page : c'est la date d'appel appliquee a ses lignes.
// ---------------------------------------------------------------------------

const INSTRUCTION_PAGE = `Ceci est UNE page d'un "RAPPORT DES RECEPTIONS CLIENTS - LISTE D'APPELS", un tableau IMPRIME ou un commercial relance par telephone d'anciens clients recus au showroom. Le seul manuscrit est la colonne Commentaire et, parfois, une DATE griffonnee a part sur la page (= date des appels de cette page).
Renvoie UNIQUEMENT du JSON, cette forme exacte :
{
  "type_fiche": "reception" si le titre est bien un rapport de receptions / liste d'appels imprime, sinon "autre",
  "agent": "<nom apres 'LISTE D'APPELS :' ou colonne 'Agent charge de l'appel'>",
  "date_session_brut": "<date manuscrite isolee sur la page (ex '29/09/2026'), sinon ''>",
  "lignes": [
    {
      "nom": "<Nom du client (imprime)>",
      "telephone": "<Telephone (imprime), chiffres>",
      "date_reception": "<Date de reception imprimee>",
      "origine": "<colonne Origine>",
      "vehicules": "<colonne Vehicules d'interet>",
      "commentaire": "<le commentaire MANUSCRIT, transcrit fidelement>"
    }
  ]
}
Lis TOUTES les lignes de CETTE page. Ne corrige pas les numeros. Info absente = "".`;

// Le resultat de la relance est en texte libre dans le commentaire.
function analyserCommentaireRelance(commentaire) {
  const t = (commentaire || "").toUpperCase();
  if (!t.trim()) return { statut: "ambigu" };

  const whatsapp = /WHATSAPP|WHATSAPP|\bWHA\b|\bWA\b/.test(t);
  const dateCom = detecterDate(commentaire);

  // Priorite : une preuve d'action datee/qualifiee prime.
  if (/RDV|RENDEZ|SHOWROOM/.test(t)) {
    const video = /VID[EÉ]O|VISIO/.test(t);
    return { statut: "ok", event_type: video ? "video_call" : "call", sous_type: video ? "video_meeting_booked" : "meeting_booked", rdv_date: dateCom, whatsapp };
  }
  if (/RELANC|RAPPEL/.test(t) && !whatsapp) {
    return { statut: "ok", event_type: "call", sous_type: "call_back", callback_date: dateCom, whatsapp };
  }
  if (/NOUS\s*REVIEN|REVIEN/.test(t)) return { statut: "ok", event_type: "call", sous_type: "wiil_come_back", whatsapp };
  if (/NPI|PAS\s*INT|N.?EST\s*PAS\s*INT/.test(t)) return { statut: "ok", event_type: "call", sous_type: "not_interested", whatsapp };
  if (/NRP|NHA/.test(t)) return { statut: "ok", event_type: "call", sous_type: "no_answer", whatsapp };
  if (whatsapp) return { statut: "ok", event_type: "message", sous_type: null, note: "Relance WhatsApp", whatsapp };
  if (/PROFORMA|PROFORMATA/.test(t)) return { statut: "ok", event_type: "call", sous_type: "interested", note: "Proforma", whatsapp };
  return { statut: "ambigu" };
}

function fusionner(pages) {
  const ok = pages.filter(Boolean);
  const entete = ok.find((p) => p.agent) || {};
  return {
    type_fiche: ok.find((p) => p.type_fiche)?.type_fiche || "autre",
    agent: entete.agent || "",
    // On garde la date de session par page pour la porter sur ses lignes.
    lignes: ok.flatMap((p) => (p.lignes || []).map((l) => ({ ...l, date_session_brut: p.date_session_brut || "" }))),
  };
}

async function extraireFicheReception(chemin) {
  // Meme cache par empreinte que les fiches d'appel : un scan deja lu est repris
  // (0 cout). Cache commun ocr_cache, l'extraction porte type_fiche.
  const octets = fs.readFileSync(chemin);
  const hash = crypto.createHash("sha256").update(octets).digest("hex");
  const cache = lireOcr(hash);
  if (cache) {
    try {
      const r = JSON.parse(cache.extraction);
      if (r && r.type_fiche === "reception") {
        console.log(`[ocr] cache hit ${hash.slice(0, 8)} (reception)`);
        return r;
      }
    } catch { /* relire */ }
  }

  let resultat;
  const ext = path.extname(chemin).toLowerCase();
  if (ext === ".pdf" && (await popplerDispo())) {
    const { images, dossier } = await pdfEnImages(chemin);
    try {
      const pages = await Promise.all(images.map((img) => extraireFichierJson(INSTRUCTION_PAGE, img).catch(() => null)));
      resultat = fusionner(pages);
      const corpus = path.join(process.env.OCR_IMAGES_DIR || path.join(__dirname, "..", "data", "ocr_images"), hash);
      archiverImages(corpus, images);
    } finally {
      nettoyer(dossier);
    }
  } else {
    resultat = fusionner([await extraireFichierJson(INSTRUCTION_PAGE, chemin)]);
  }

  // On ne met en cache QUE si c'est bien une reception (sinon on laisse la voie
  // fiche d'appel gerer et cacher a sa maniere).
  if (resultat && resultat.type_fiche === "reception") {
    try {
      enregistrerOcr({
        hash, fichier: path.basename(chemin).replace(/^\d+-/, ""),
        extraction: JSON.stringify(resultat), modele: process.env.IA_MODELE_VISION || "",
        nb_lignes: resultat.lignes ? resultat.lignes.length : 0,
      });
    } catch (e) { console.error("[ocr] cache reception:", e.message); }
  }
  return resultat;
}

async function resoudreAgent(nom) {
  if (!nom) return null;
  const jeton = String(nom).trim().split(/\s+/)[0];
  if (!jeton) return null;
  const u = await rechercherLire("res.users", [["name", "ilike", jeton]], ["id", "name"], { limit: 1 });
  return u.length ? u[0] : null;
}

async function construirePlanRelance(extraction, indice = "") {
  const agentUser = await resoudreAgent(extraction.agent);
  const plan = {
    type: "relance",
    ocr_hash: extraction.hash || null,
    agent: extraction.agent || null,
    agent_id: agentUser ? agentUser.id : null,
    // Date d'appel par defaut : celle de l'indice (legende/nom fichier), sinon
    // aujourd'hui. Chaque ligne peut la surcharger via sa date de session.
    event_date: `${detecterDate(indice) || aujourdhuiCmr()} 12:00:00`,
    actions: [],
    ambigus: [],
    invalides: [],
  };

  for (const ligne of extraction.lignes || []) {
    const tel = normaliserTelephone(ligne.telephone);
    const res = analyserCommentaireRelance(ligne.commentaire);

    if (res.statut === "ambigu") {
      plan.ambigus.push({ nom: ligne.nom, telephone: tel, commentaire: ligne.commentaire });
      continue;
    }
    if (!telephoneValide(tel)) {
      plan.invalides.push({ nom: ligne.nom, telephone: ligne.telephone });
      continue;
    }

    // Date d'appel = date de session griffonnee sur la page ; sinon l'indice
    // (legende/nom de fichier) ; sinon rien (on demandera).
    const dateSession = detecterDate(ligne.date_session_brut) || detecterDate(indice);
    const existantes = await chercherParTelephone(tel);
    const piste = existantes[0] || null;

    const notes = [
      ligne.commentaire || "",
      res.note ? `[${res.note}]` : "",
      res.whatsapp && res.event_type !== "message" ? "[relance WhatsApp]" : "",
      ligne.vehicules ? `Vehicule: ${ligne.vehicules}` : "",
      ligne.date_reception ? `Recu le ${ligne.date_reception}` : "",
      ligne.origine ? `Origine: ${ligne.origine}` : "",
      `(relance ${plan.agent || "?"})`,
    ].filter(Boolean).join(" ").trim();

    const action = {
      nom: (ligne.nom || "").trim(),
      telephone: tel,
      piste_id: piste ? piste.id : null,
      piste_nom: piste ? piste.contact_name || piste.name : null,
      nouvelle_piste: !piste,
      event_type: res.event_type,
      sous_type: res.sous_type,
      event_date: dateSession ? `${dateSession} 12:00:00` : null,
      notes,
      rdv: null,
    };

    if (res.sous_type === "meeting_booked" || res.sous_type === "video_meeting_booked") {
      if (res.rdv_date) action.rdv = { date: res.rdv_date, resume: `RDV: ${action.nom || tel}` };
    } else if (res.sous_type === "call_back" && res.callback_date) {
      action.rdv = { date: res.callback_date, resume: `Relance prevue: ${action.nom || tel}` };
    }

    plan.actions.push(action);
  }

  plan.resume = {
    total_lignes: (extraction.lignes || []).length,
    a_ecrire: plan.actions.length,
    nouvelles_pistes: plan.actions.filter((a) => a.nouvelle_piste).length,
    rdv: plan.actions.filter((a) => a.rdv).length,
    whatsapp: plan.actions.filter((a) => a.event_type === "message").length,
    ambigus: plan.ambigus.length,
    invalides: plan.invalides.length,
    sans_date: plan.actions.filter((a) => !a.event_date).length,
  };
  return plan;
}

function resumePlanRelance(plan) {
  const r = plan.resume;
  const lignes = [
    `Fiche de relance (receptions)${plan.agent ? ` — ${plan.agent}` : ""} :`,
    `- ${r.total_lignes} lignes lues`,
    `- ${r.a_ecrire} appels a enregistrer, dont ${r.nouvelles_pistes} nouvelles pistes, ${r.rdv} RDV/relances datees, ${r.whatsapp} relances WhatsApp`,
  ];
  if (r.ambigus) lignes.push(`- ${r.ambigus} commentaires non compris NON importes`);
  if (r.invalides) lignes.push(`- ${r.invalides} numeros invalides ignores`);
  if (r.sans_date) lignes.push(`- ${r.sans_date} sans date de session (date par defaut appliquee)`);
  if (!plan.agent_id) lignes.push(`- ATTENTION : agent "${plan.agent}" non retrouve dans Odoo, appels non attribues`);
  lignes.push("", 'J\'enregistre tout ca dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return lignes.join("\n");
}

module.exports = { extraireFicheReception, analyserCommentaireRelance, construirePlanRelance, resumePlanRelance };
