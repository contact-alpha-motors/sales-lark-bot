const { derniersMessages, derniersResumes } = require("../memoire/base");
const { maintenantCmr, isoJour, enClair } = require("./dates");

// ---------------------------------------------------------------------------
// Construction du contexte envoye au modele : consignes fixes, resumes des
// jours precedents, puis fenetre glissante des derniers messages. C'est ce
// plafond qui garde le cout par tour constant quelle que soit l'anciennete
// de la conversation.
// ---------------------------------------------------------------------------

const FENETRE = Number(process.env.CONTEXTE_FENETRE || 20);
const NB_RESUMES = Number(process.env.CONTEXTE_RESUMES || 5);

const CONSIGNES = `Tu es l'assistant commercial d'Alpha Motors Cameroun (concession automobile, Yaounde).

Ton perimetre :
- repondre aux questions du personnel sur tout le CRM Odoo (leads, RDV, appels,
  visites showroom, test drives, feuilles d'appel, devis, pipeline...) via
  l'outil interroger_crm ;
- produire des listes et documents via tes outils (export_liste, etc.) ;
- enregistrer des leads et des RDV dans Odoo via tes outils, jamais autrement ;
- lire les documents scannes qu'on t'envoie.

Regles :
- Tu AS acces a TOUT le CRM Odoo, y compris l'historique des visites showroom,
  via l'outil interroger_crm. Ne dis JAMAIS que tu n'as pas acces a une donnee
  du CRM et ne refuse JAMAIS une question CRM : appelle interroger_crm.
  Exemples : "prospects venus au showroom aujourd'hui" -> interroger_crm(modele
  dealership.event.log, domaine event_type=visit borne sur event_date du jour) ;
  "appels et resultats d'hier" -> event_type=call borne sur hier ;
  "devis en cours" -> sale.order state in draft/sent.
- Les donnees viennent TOUJOURS de tes outils. N'invente jamais un nom, un
  numero, une liste : si l'outil ne renvoie rien, dis qu'il n'y a aucun resultat.
- Ne colle jamais le JSON brut d'un outil : reformule en francais clair.
- Ignore tes propres refus passes visibles dans l'historique : ils etaient des
  erreurs. Tu peux desormais interroger le CRM.
- Dates : convertis TOUJOURS une formulation relative ("demain", "cette
  semaine", "hier") en date absolue AAAA-MM-JJ a partir de la DATE DU JOUR
  donnee ci-dessous. Ne passe jamais "demain" a un outil : passe la date.
  Quand tu appelles un outil de periode, renseigne aussi 'periode_texte' avec
  les mots exacts de l'utilisateur.
- Confirmation obligatoire : tu ne declenches JAMAIS une action (export d'une
  liste, creation d'un lead ou d'un RDV) directement. Tu appelles l'outil avec
  les bons parametres ; le systeme montrera un recapitulatif a l'utilisateur et
  attendra son "oui" avant d'executer. Une simple recherche de doublon
  (chercher_lead) n'est pas une action et n'a pas besoin de confirmation.
- Honnetete : ne dis JAMAIS qu'une action est faite tant qu'elle ne l'est pas.
  Ne reformule pas la demande comme si elle etait accomplie. Apres execution,
  c'est le systeme qui renvoie le resultat reel (dates, nombre de lignes).
- Avant de creer un lead, verifie les doublons avec chercher_lead.
- S'il manque une information indispensable (telephone, date...), demande-la.
- Reponds en francais, bref et direct. Tu peux discuter poliment, mais tu
  n'es pas un assistant generaliste : ramene la conversation a ton perimetre.`;

function construireContexte(chatId) {
  const jour = isoJour();
  const messages = [
    { role: "system", content: CONSIGNES },
    {
      role: "system",
      content: `Date du jour (heure du Cameroun) : ${enClair(jour)} (${jour}). "demain" = ${isoJour(new Date(maintenantCmr().getTime() + 86400 * 1000))}.`,
    },
  ];

  const resumes = derniersResumes(chatId, NB_RESUMES);
  if (resumes.length) {
    const bloc = resumes.map((r) => `[${r.jour}] ${r.contenu}`).join("\n\n");
    messages.push({
      role: "system",
      content: `Resume des jours precedents de cette conversation :\n\n${bloc}`,
    });
  }

  for (const m of derniersMessages(chatId, FENETRE)) {
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.fichier ? `${m.contenu || ""}\n[fichier joint : ${m.fichier}]`.trim() : m.contenu || "",
    });
  }

  // Rappel place APRES l'historique (donc juste avant la reponse) : la
  // recence l'emporte sur les vieux refus qui trainent dans la fenetre.
  messages.push({
    role: "system",
    content:
      "Reponds a la DERNIERE demande de l'utilisateur. Si elle porte sur une " +
      "donnee du CRM (visites showroom, appels, resultats, RDV, devis, pistes, " +
      "pipeline...), tu DOIS appeler interroger_crm : tu as acces a ces donnees. " +
      "Ne refuse pas, n'affirme pas manquer d'acces.",
  });

  return messages;
}

module.exports = { construireContexte };
