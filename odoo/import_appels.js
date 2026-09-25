const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { creer, rechercherLire } = require("./rpc");
const { enregistrerOcr, lireOcr } = require("../memoire/base");
const { chercherParTelephone } = require("./requetes");
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
Renvoie UNIQUEMENT du JSON, cette forme exacte :
{
  "agent": "<nom en en-tete de page>",
  "date_appels_brut": "<texte brut de la date en en-tete, ex '22/09/26'>",
  "lignes": [
    {
      "nom": "<nom du prospect ou ''>",
      "telephone": "<chiffres du numero>",
      "statut_precedent": "<colonne statut imprimee ou ''>",
      "code_resultat": "<le code manuscrit du resultat: PP, PI, NR, NRP, RDV, BL, OUI, PL, PEL...>",
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
    try { return JSON.parse(cache.extraction); } catch { /* cache corrompu -> relire */ }
  }

  let resultat;
  const ext = path.extname(chemin).toLowerCase();
  if (ext === ".pdf" && (await popplerDispo())) {
    const { images, dossier } = await pdfEnImages(chemin);
    try {
      const pages = await Promise.all(
        images.map((img) => extraireFichierJson(INSTRUCTION_PAGE, img).catch(() => null))
      );
      resultat = fusionnerPages(pages);
    } finally {
      nettoyer(dossier);
    }
  } else {
    resultat = await extraireFichierJson(INSTRUCTION_PAGE, chemin);
  }

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

async function resoudreAgent(nom) {
  if (!nom) return null;
  const jeton = String(nom).trim().split(/\s+/)[0]; // "Astride AH" -> "Astride"
  if (!jeton) return null;
  const users = await rechercherLire("res.users", [["name", "ilike", jeton]], ["id", "name"], { limit: 1 });
  return users.length ? users[0] : null;
}

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

    const notes = [
      ligne.commentaire || "",
      res.note ? `[${res.note}]` : "",
      ligne.vehicule ? `Vehicule: ${ligne.vehicule}` : "",
      `(fiche ${plan.agent} ${plan.date_appels || ""})`,
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

// Ecrit le plan dans Odoo. Chaque ligne est isolee dans son try/catch : une
// ligne qui echoue n'emporte pas le reste de la fiche.
async function executerPlan(plan) {
  const resultat = { pistes_creees: 0, evenements: 0, activites: 0, echecs: [] };

  for (const a of plan.actions) {
    try {
      let leadId = a.piste_id;
      if (!leadId) {
        leadId = await creer("crm.lead", {
          name: a.nom || `Prospect ${a.telephone}`,
          contact_name: a.nom || undefined,
          phone: a.telephone,
          type: "lead",
        });
        resultat.pistes_creees += 1;
      }

      const evenement = {
        event_type: a.event_type,
        sub_type: a.sous_type,
        lead_id: leadId,
        event_date: plan.event_date,
        contact_phone: a.telephone,
        notes: a.notes,
      };
      if (plan.agent_id) evenement.user_id = plan.agent_id;
      await creer("dealership.event.log", evenement);
      resultat.evenements += 1;

      if (a.rdv) {
        const activite = {
          res_model: "crm.lead",
          res_id: leadId,
          activity_type_id: TYPE_ACTIVITE_RDV,
          date_deadline: a.rdv.date,
          summary: a.rdv.resume,
        };
        if (plan.agent_id) activite.user_id = plan.agent_id;
        try {
          await creer("mail.activity", activite);
          resultat.activites += 1;
        } catch (e) {
          // L'activite est un bonus : son echec ne doit pas perdre l'evenement.
          resultat.echecs.push({ telephone: a.telephone, etape: "activite", erreur: e.message });
        }
      }
    } catch (e) {
      resultat.echecs.push({ telephone: a.telephone, etape: "evenement", erreur: e.message });
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

module.exports = { extraireFeuilleAppel, construirePlan, executerPlan, resumePlan, completerEntete };
