const path = require("path");
const { converser, lireFichier } = require("../ia");
const { construireContexte } = require("./contexte");
const { OUTILS, schemas } = require("./outils");
const { peutExecuter } = require("./droits");
const { extraireFeuilleAppel, construirePlan, executerPlan, resumePlan, completerEntete } = require("../odoo/import_appels");
const {
  enregistrerMessage,
  poserActionEnAttente,
  lireActionEnAttente,
  prendreActionEnAttente,
  journaliser,
} = require("../memoire/base");

// ---------------------------------------------------------------------------
// La boucle de l'agent : contexte -> modele -> outils -> reponse.
//
// Toute action visible (export d'une liste, creation de lead/RDV) s'arrete en
// "action en attente" : le bot enonce ce qu'il va faire — en reprenant les
// mots de l'utilisateur ET en donnant les dates absolues — et attend un OUI au
// tour suivant. Seules les recherches internes (chercher_lead) s'executent
// directement, ce ne sont pas des actions.
// ---------------------------------------------------------------------------

const MAX_TOURS_OUTILS = 5;

const CONFIRMATIONS = /^(oui|ok|confirme|confirmer|vas-y|go|yes)\b/i;
const ANNULATIONS = /^(non|annule|annuler|stop|no)\b/i;

async function traiterMessage({ chatId, senderId, messageId, texte, cheminFichier }) {
  // Fichier joint : on tente d'abord d'y lire une FICHE D'APPEL a importer
  // (cas principal). Si ca n'en est pas une, on retombe sur la transcription.
  if (cheminFichier) {
    let extraction = null;
    try {
      extraction = await extraireFeuilleAppel(cheminFichier);
    } catch (e) {
      console.error(`[import] extraction fiche echouee : ${e.message}`);
    }

    if (extraction && Array.isArray(extraction.lignes) && extraction.lignes.length) {
      enregistrerMessage({
        message_id: messageId, chat_id: chatId, sender_id: senderId, role: "user",
        contenu: `${texte || ""}\n[fiche d'appel jointe]`.trim(), fichier: cheminFichier,
      });

      if (!peutExecuter(senderId, "creer_lead")) {
        return repondre(chatId, "Tu n'as pas le droit d'importer des appels dans Odoo. Contacte un responsable.");
      }

      console.log(`[agent ${chatId.slice(-6)}] fiche d'appel detectee : ${extraction.lignes.length} lignes`);
      // Indice pour l'agent + la date : legende + nom de fichier (sans le
      // prefixe horodatage). Souvent "Fiche Ben 22 septembre.pdf".
      const indice = `${texte || ""} ${path.basename(cheminFichier).replace(/^\d+-/, "")}`;
      const plan = await construirePlan(extraction, indice);
      poserActionEnAttente(chatId, "import_appels", plan, "Import fiche d'appel");
      return repondre(chatId, resumePlan(plan));
    }
  }

  // Sinon : transcription classique du document pour la conversation.
  let contenu = texte || "";
  if (cheminFichier) {
    const extrait = await lireFichier(
      "Transcris fidelement le contenu de ce document (texte, tableaux, noms, numeros). Ne resume pas, n'invente rien.",
      cheminFichier
    );
    contenu = `${contenu}\n\n[Contenu du document joint]\n${extrait}`.trim();
  }

  enregistrerMessage({
    message_id: messageId,
    chat_id: chatId,
    sender_id: senderId,
    role: "user",
    contenu,
    fichier: cheminFichier || null,
  });

  // Fiche d'appel en attente d'en-tete : l'utilisateur fournit agent + date
  // (ex. « Ben 22/09/26 ») sans qu'on re-extraie la fiche.
  if (texte && !CONFIRMATIONS.test(texte.trim()) && !ANNULATIONS.test(texte.trim())) {
    const enAttente = lireActionEnAttente(chatId);
    if (enAttente && enAttente.outil === "import_appels" && enteteInvalide(enAttente.parametres)) {
      const plan = enAttente.parametres;
      await completerEntete(plan, texte);
      poserActionEnAttente(chatId, "import_appels", plan, "Import fiche d'appel");
      return repondre(chatId, resumePlan(plan));
    }
  }

  // Une ecriture attendait-elle une confirmation dans ce chat ?
  if (texte && (CONFIRMATIONS.test(texte.trim()) || ANNULATIONS.test(texte.trim()))) {
    const attente = prendreActionEnAttente(chatId);
    if (attente) {
      if (ANNULATIONS.test(texte.trim())) {
        return repondre(chatId, "D'accord, j'annule. Rien n'a ete ecrit dans Odoo.");
      }

      // Import d'une fiche d'appel : execute le plan (ecriture directe).
      if (attente.outil === "import_appels") {
        // Garde-fou : agent/date manquants OU date aberrante (ex. vieux plan
        // "202-08-27") -> on redemande l'en-tete au lieu d'ecrire n'importe quoi.
        if (enteteInvalide(attente.parametres)) {
          poserActionEnAttente(chatId, "import_appels", attente.parametres, "Import fiche d'appel");
          return repondre(chatId, "Il me faut l'agent et une date valide (ex : « Ben 22/09/26 ») avant d'enregistrer.");
        }
        const r = await executerPlan(attente.parametres);
        journaliser(chatId, senderId, "import_appels", { agent: attente.parametres.agent, resume: attente.parametres.resume }, r);
        let msg = `Import termine : ${r.pistes_creees} nouvelle(s) piste(s), ${r.evenements} appel(s) enregistre(s), ${r.activites} RDV cree(s).`;
        if (r.echecs.length) msg += ` ${r.echecs.length} ligne(s) en echec.`;
        return repondre(chatId, msg);
      }

      const outil = OUTILS[attente.outil];
      const resultat = await outil.executer(attente.parametres);
      journaliser(chatId, senderId, attente.outil, attente.parametres, resultat);
      return repondre(chatId, resultat.texte, resultat.fichier);
    }
  }

  // Boucle modele + outils.
  const messages = construireContexte(chatId);
  let fichierAEnvoyer = null;

  for (let tour = 0; tour < MAX_TOURS_OUTILS; tour++) {
    const reponse = await converser(messages, schemas());

    if (!reponse.tool_calls?.length) {
      console.log(`[agent ${chatId.slice(-6)}] aucune tool_call, reponse directe`);
      return repondre(chatId, reponse.content || "…", fichierAEnvoyer);
    }

    console.log(`[agent ${chatId.slice(-6)}] outils demandes : ${reponse.tool_calls.map((t) => t.function.name).join(", ")}`);
    messages.push(reponse);

    for (const appel of reponse.tool_calls) {
      const nom = appel.function.name;
      const outil = OUTILS[nom];
      const parametres = JSON.parse(appel.function.arguments || "{}");

      if (!outil) {
        messages.push({ role: "tool", tool_call_id: appel.id, content: `Outil inconnu : ${nom}` });
        continue;
      }

      // Controle des droits d'ecriture avant toute chose.
      if (outil.ecriture && !peutExecuter(senderId, nom)) {
        return repondre(chatId, "Tu n'as pas le droit d'ecrire dans Odoo. Contacte un responsable.");
      }

      // Action visible : on ne l'execute pas, on la gele et on demande "oui".
      // Court-circuit : c'est NOUS qui redigeons le recapitulatif (dates
      // absolues), pas le modele — sinon il risque de "confirmer" une action
      // qu'il n'a pas faite.
      if (outil.confirmer) {
        const description = outil.decrire(parametres);
        poserActionEnAttente(chatId, nom, parametres, description);
        return repondre(
          chatId,
          `${description}.\n\nJe le fais ? Reponds « oui » pour confirmer, « non » pour annuler.`
        );
      }

      // Recherche interne : execution immediate, la boucle continue.
      const retour = await outil.executer(parametres);
      journaliser(chatId, senderId, nom, parametres, { texte: retour.texte });
      if (retour.fichier) fichierAEnvoyer = retour.fichier;
      messages.push({ role: "tool", tool_call_id: appel.id, content: retour.texte });
    }
  }

  return repondre(chatId, "Je n'ai pas reussi a conclure cette demande, reformule ou decoupe-la.", fichierAEnvoyer);
}

// En-tete inexploitable : agent/date manquants, ou date hors d'une plage
// plausible (protege contre un vieux plan mal date comme "202-08-27").
function enteteInvalide(plan) {
  const annee = plan.event_date ? Number(String(plan.event_date).slice(0, 4)) : 0;
  return !!plan.besoin_entete || !plan.agent || !(annee >= 2024 && annee <= 2028);
}

function repondre(chatId, texte, fichier = null) {
  enregistrerMessage({ chat_id: chatId, role: "assistant", contenu: texte, fichier });
  return { texte, fichier };
}

module.exports = { traiterMessage };
