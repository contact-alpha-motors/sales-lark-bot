const path = require("path");
const { creer, rechercherLire } = require("./rpc");
const { chercherParTelephone } = require("./requetes");
const { normaliserTelephone, telephoneValide, analyserResultat } = require("../coeur/referentiel");
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
  const ext = path.extname(chemin).toLowerCase();

  if (ext === ".pdf" && (await popplerDispo())) {
    const { images, dossier } = await pdfEnImages(chemin);
    try {
      const pages = await Promise.all(
        images.map((img) => extraireFichierJson(INSTRUCTION_PAGE, img).catch(() => null))
      );
      return fusionnerPages(pages);
    } finally {
      nettoyer(dossier);
    }
  }

  return extraireFichierJson(INSTRUCTION_PAGE, chemin);
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
async function construirePlan(extraction) {
  const agent = await resoudreAgent(extraction.agent);
  // La date d'en-tete est parsee en code (JJ/MM/AA) : les modeles lisaient
  // "22/09/26" comme 2022 et dataient les appels en 2022.
  const dateAppels = parserDateRdv(extraction.date_appels_brut, 2026);
  const anneeDefaut = dateAppels ? Number(dateAppels.slice(0, 4)) : 2026;
  const eventDate = `${dateAppels || `${anneeDefaut}-01-01`} 12:00:00`;

  const plan = {
    agent: agent ? agent.name : extraction.agent || "?",
    agent_id: agent ? agent.id : null,
    date_appels: dateAppels,
    event_date: eventDate,
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
    `Fiche d'appel de ${plan.agent}${plan.date_appels ? ` (${plan.date_appels})` : ""} :`,
    `- ${r.total_lignes} lignes lues`,
    `- ${r.a_ecrire} appels a enregistrer, dont ${r.nouvelles_pistes} nouvelles pistes et ${r.rdv} RDV`,
  ];
  if (r.ambigus) lignes.push(`- ${r.ambigus} codes ambigus (PP/OUI/inconnu) NON importes`);
  if (r.routage) lignes.push(`- ${r.routage} demandes partenariat/emploi (DP/DE) NON importees`);
  if (r.invalides) lignes.push(`- ${r.invalides} numeros invalides ignores`);
  if (!plan.agent_id) lignes.push(`- ATTENTION : agent "${plan.agent}" non retrouve dans Odoo, appels non attribues`);
  lignes.push("", 'J\'enregistre tout ca dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return lignes.join("\n");
}

module.exports = { extraireFeuilleAppel, construirePlan, executerPlan, resumePlan };
