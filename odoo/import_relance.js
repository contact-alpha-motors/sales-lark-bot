const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { rechercherLire } = require("./rpc");
const { chercherParTelephone, resoudreUtilisateur } = require("./requetes");
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
      "agent_ligne": "<valeur de la colonne 'Agent charge de l'appel' pour cette ligne>",
      "commentaire": "<le commentaire MANUSCRIT, transcrit fidelement>"
    }
  ]
}
Lis TOUTES les lignes de CETTE page. Ne corrige pas les numeros. Info absente = "".`;

// Le resultat de la relance est en texte libre (manuscrit, souvent mal OCR).
// Regle : on NE JETTE JAMAIS une ligne. Si le code n'est pas clair, on importe
// quand meme un appel avec le commentaire garde et un tag "a categoriser".
// Patterns tolerants aux fautes d'OCR (RDY, RELA..., RELIEN, HRP, KIHA...).
function analyserCommentaireRelance(commentaire) {
  const t = (commentaire || "").toUpperCase();
  if (!t.replace(/[^A-Z0-9]/g, "")) return { statut: "vide" }; // aucun texte -> pas d'appel

  const whatsapp = /WHATSA|\bWHA\b|KIHA|\bKHA\b|\bWA\b/.test(t);
  const dateCom = detecterDate(commentaire);

  if (/RD[VY]|RENDEZ|SHOWROO/.test(t)) {
    const video = /VID[EÉ]O|VISIO/.test(t);
    return { statut: "ok", event_type: video ? "video_call" : "call", sous_type: video ? "video_meeting_booked" : "meeting_booked", rdv_date: dateCom, whatsapp };
  }
  if (/RELA|RAPPEL/.test(t) && !whatsapp) {
    return { statut: "ok", event_type: "call", sous_type: "call_back", callback_date: dateCom, whatsapp };
  }
  if (/REVIEN|RELIEN|NOUS\s*R/.test(t)) return { statut: "ok", event_type: "call", sous_type: "wiil_come_back", whatsapp };
  if (/NPI|NLP|PAS\s*INT/.test(t)) return { statut: "ok", event_type: "call", sous_type: "not_interested", whatsapp };
  if (/N[RH]P|HRP|NHA|MRB|NRB/.test(t)) return { statut: "ok", event_type: "call", sous_type: "no_answer", whatsapp };
  if (whatsapp) return { statut: "ok", event_type: "message", sous_type: null, note: "Relance WhatsApp", whatsapp };
  if (/PROFORMA/.test(t)) return { statut: "ok", event_type: "call", sous_type: "interested", note: "Proforma", whatsapp };

  // Non categorise : importe quand meme, commentaire garde, marque a revoir.
  return { statut: "ok", event_type: "call", sous_type: null, note: "A categoriser", whatsapp, non_categorise: true };
}

function fusionner(pages) {
  const ok = pages.filter(Boolean);
  const entete = ok.find((p) => p.agent) || {};
  return {
    type_fiche: ok.find((p) => p.type_fiche)?.type_fiche || "autre",
    agent: entete.agent || "",
    // On garde la date de session par page pour la porter sur ses lignes, et le
    // numero de page (ordre de lecture) pour pouvoir signaler les pages sans date.
    lignes: ok.flatMap((p, idx) => (p.lignes || []).map((l) => ({ ...l, date_session_brut: p.date_session_brut || "", _page: idx + 1 }))),
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
      // On n'utilise le cache que s'il porte le schema courant (agent par ligne) ;
      // sinon on re-extrait une fois pour recuperer les agents par ligne.
      if (r && r.type_fiche === "reception" && r.lignes && r.lignes[0] && "agent_ligne" in r.lignes[0]) {
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

const resoudreAgent = resoudreUtilisateur;

async function construirePlanRelance(extraction, indice = "") {
  const agentUser = await resoudreAgent(extraction.agent);
  // Les fiches sont ordonnees par sections d'agent : une cellule d'agent vide
  // ou mal lue herite du dernier agent resolu (le commercial de la section).
  let dernierAgent = agentUser;
  const plan = {
    type: "relance",
    ocr_hash: extraction.hash || null,
    agent: extraction.agent || null,
    agent_id: agentUser ? agentUser.id : null,
    // Date d'appel par defaut : celle de l'indice (legende/nom fichier), sinon
    // aujourd'hui. Chaque ligne peut la surcharger via sa date de session.
    event_date: `${detecterDate(indice) || aujourdhuiCmr()} 12:00:00`,
    actions: [],
    vides: [],
    invalides: [],
    sans_date: [], // lignes NON importees faute de date d'appel (page a dater)
  };

  for (const ligne of extraction.lignes || []) {
    const tel = normaliserTelephone(ligne.telephone);
    const res = analyserCommentaireRelance(ligne.commentaire);

    if (res.statut === "vide") {
      plan.vides.push({ nom: ligne.nom, telephone: tel });
      continue;
    }
    if (!telephoneValide(tel)) {
      plan.invalides.push({ nom: ligne.nom, telephone: ligne.telephone });
      continue;
    }

    // Date d'appel = date de session griffonnee sur la page ; sinon l'indice
    // (legende/nom de fichier). Sans date, on NE DEVINE PAS : la ligne est mise
    // de cote et la page signalee, pour qu'une vraie date soit ajoutee.
    const dateSession = detecterDate(ligne.date_session_brut) || detecterDate(indice);
    if (!dateSession) {
      plan.sans_date.push({ nom: ligne.nom, telephone: tel, page: ligne._page || null });
      continue;
    }
    // Agent PAR LIGNE (colonne "Agent charge de l'appel") : gere les paquets
    // multi-commerciaux. Cellule vide/mal lue -> herite du dernier agent resolu.
    const agentLigne = ligne.agent_ligne ? await resoudreAgent(ligne.agent_ligne) : null;
    if (agentLigne) dernierAgent = agentLigne;
    const agentEffectif = agentLigne || dernierAgent;
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
      agent_id: agentEffectif ? agentEffectif.id : null,
      agent_nom: agentEffectif ? agentEffectif.name : (ligne.agent_ligne || plan.agent || "?"),
      non_categorise: !!res.non_categorise,
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
    non_categorises: plan.actions.filter((a) => a.non_categorise).length,
    vides: plan.vides.length,
    invalides: plan.invalides.length,
    sans_date: plan.sans_date.length,
    // Pages (ordre de lecture) qui n'ont aucune date d'appel -> a dater.
    pages_sans_date: [...new Set(plan.sans_date.map((l) => l.page).filter(Boolean))].sort((a, b) => a - b),
  };
  // Repartition par agent (le fichier peut etre un paquet de plusieurs commerciaux).
  const parAgent = {};
  for (const a of plan.actions) {
    const nom = a.agent_nom || "?";
    if (!parAgent[nom]) parAgent[nom] = { n: 0, resolu: !!a.agent_id };
    parAgent[nom].n += 1;
  }
  plan.par_agent = parAgent;
  return plan;
}

function resumePlanRelance(plan) {
  const r = plan.resume;
  const agents = Object.entries(plan.par_agent || {});
  const enTete = agents.length > 1 ? "plusieurs commerciaux" : (agents[0] ? agents[0][0] : plan.agent || "?");
  const lignes = [
    `Fiche de relance (receptions) — ${enTete} :`,
    `- ${r.total_lignes} lignes lues`,
    `- ${r.a_ecrire} appels a enregistrer, dont ${r.nouvelles_pistes} nouvelles pistes, ${r.rdv} RDV/relances datees, ${r.whatsapp} relances WhatsApp`,
  ];
  // Detail par commercial (utile pour un paquet).
  if (agents.length) {
    lignes.push("- Par commercial :");
    for (const [nom, info] of agents.sort((a, b) => b[1].n - a[1].n)) {
      lignes.push(`   • ${nom} : ${info.n}${info.resolu ? "" : " (non retrouve dans Odoo, non attribue)"}`);
    }
  }
  if (r.non_categorises) lignes.push(`- ${r.non_categorises} commentaires importes mais « a categoriser » (code peu clair, texte garde)`);
  if (r.vides) lignes.push(`- ${r.vides} lignes sans commentaire ignorees`);
  if (r.invalides) lignes.push(`- ${r.invalides} numeros invalides ignores`);
  if (r.sans_date) {
    const pages = r.pages_sans_date && r.pages_sans_date.length ? ` (pages ${r.pages_sans_date.join(", ")})` : "";
    lignes.push(`- ⚠️ ${r.sans_date} lignes SANS date d'appel${pages} : NON importees. Ecris une date sur ces pages, ou renvoie le fichier avec la date dans le message.`);
  }
  lignes.push("", 'J\'enregistre les lignes datees dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return lignes.join("\n");
}

module.exports = { extraireFicheReception, analyserCommentaireRelance, construirePlanRelance, resumePlanRelance };
