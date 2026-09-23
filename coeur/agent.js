const { converser, lireFichier } = require("../ia");
const { construireContexte } = require("./contexte");
const { OUTILS, schemas } = require("./outils");
const { peutExecuter } = require("./droits");
const {
  enregistrerMessage,
  poserActionEnAttente,
  prendreActionEnAttente,
  journaliser,
} = require("../memoire/base");

// ---------------------------------------------------------------------------
// La boucle de l'agent : contexte -> modele -> outils -> reponse.
//
// Les lectures s'executent directement. Les ecritures Odoo s'arretent en
// "action en attente" : le bot decrit ce qu'il s'apprete a faire et attend
// un OUI de l'utilisateur au tour suivant.
// ---------------------------------------------------------------------------

const MAX_TOURS_OUTILS = 5;

const CONFIRMATIONS = /^(oui|ok|confirme|confirmer|vas-y|go|yes)\b/i;
const ANNULATIONS = /^(non|annule|annuler|stop|no)\b/i;

async function traiterMessage({ chatId, senderId, messageId, texte, cheminFichier }) {
  // Un fichier joint est d'abord transcrit : le texte extrait entre dans la
  // conversation comme n'importe quel message.
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

  // Une ecriture attendait-elle une confirmation dans ce chat ?
  if (texte && (CONFIRMATIONS.test(texte.trim()) || ANNULATIONS.test(texte.trim()))) {
    const attente = prendreActionEnAttente(chatId);
    if (attente) {
      if (ANNULATIONS.test(texte.trim())) {
        return repondre(chatId, "D'accord, j'annule. Rien n'a ete ecrit dans Odoo.");
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
      return repondre(chatId, reponse.content || "…", fichierAEnvoyer);
    }

    messages.push(reponse);

    for (const appel of reponse.tool_calls) {
      const nom = appel.function.name;
      const outil = OUTILS[nom];
      let retour;

      if (!outil) {
        retour = { texte: `Outil inconnu : ${nom}` };
      } else if (!peutExecuter(senderId, nom)) {
        retour = { texte: "Cet utilisateur n'a pas le droit d'ecrire dans Odoo." };
      } else if (outil.ecriture) {
        // On ne cree rien tout de suite : on gele l'action et on demandera OUI.
        const parametres = JSON.parse(appel.function.arguments || "{}");
        const description = outil.decrire(parametres);
        poserActionEnAttente(chatId, nom, parametres, description);
        retour = {
          texte: `Action preparee, en attente de confirmation de l'utilisateur : ${description}. Demande-lui de repondre "oui" pour executer.`,
        };
      } else {
        const parametres = JSON.parse(appel.function.arguments || "{}");
        retour = await outil.executer(parametres);
        journaliser(chatId, senderId, nom, parametres, { texte: retour.texte });
        if (retour.fichier) fichierAEnvoyer = retour.fichier;
      }

      messages.push({
        role: "tool",
        tool_call_id: appel.id,
        content: retour.texte,
      });
    }
  }

  return repondre(chatId, "Je n'ai pas reussi a conclure cette demande, reformule ou decoupe-la.", fichierAEnvoyer);
}

function repondre(chatId, texte, fichier = null) {
  enregistrerMessage({ chat_id: chatId, role: "assistant", contenu: texte, fichier });
  return { texte, fichier };
}

module.exports = { traiterMessage };
