const Lark = require("@larksuiteoapi/node-sdk");
const { traiterMessage } = require("../coeur/agent");
const { messageDejaTraite } = require("../memoire/base");
const { telechargerPieceJointe, envoyerTexte, envoyerFichier } = require("./fichiers");

// ---------------------------------------------------------------------------
// Adaptateur Lark : un WSClient par espace de travail, tous branches sur le
// meme coeur d'agent. Le jour ou WhatsApp arrive, ce sera un deuxieme
// adaptateur sur le meme coeur — rien d'autre ne change.
//
// Regles d'ecoute :
//   - en prive (p2p) : le bot repond a tout ;
//   - en groupe : uniquement quand il est mentionne (@bot), pour que les
//     conversations d'equipe ne declenchent pas de modele.
// ---------------------------------------------------------------------------

function extraireTexte(message) {
  try {
    const contenu = JSON.parse(message.content || "{}");
    // Les mentions arrivent sous forme "@_user_1" dans le texte : on les retire.
    return (contenu.text || "").replace(/@_user_\d+/g, "").trim();
  } catch {
    return "";
  }
}

async function extraireFichier(client, message) {
  try {
    const contenu = JSON.parse(message.content || "{}");

    if (message.message_type === "image" && contenu.image_key) {
      return telechargerPieceJointe(client, message.message_id, contenu.image_key, "image", "image.png");
    }

    if (message.message_type === "file" && contenu.file_key) {
      return telechargerPieceJointe(client, message.message_id, contenu.file_key, "file", contenu.file_name || "document");
    }
  } catch (erreur) {
    console.error("Piece jointe illisible :", erreur.message);
  }

  return null;
}

function demarrerAdaptateur({ appId, appSecret, etiquette }) {
  const config = { appId, appSecret, domain: Lark.Domain.Lark };
  const client = new Lark.Client(config);
  const wsClient = new Lark.WSClient(config);

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const message = data.message;
      if (!message) return;

      try {
        // Idempotence : Lark relivre les evenements non acquittes.
        if (messageDejaTraite(message.message_id)) return;

        // En groupe, seuls les messages qui mentionnent le bot comptent.
        if (message.chat_type === "group" && !(message.mentions || []).length) return;

        const texte = extraireTexte(message);
        const cheminFichier = await extraireFichier(client, message);

        if (!texte && !cheminFichier) return;

        const reponse = await traiterMessage({
          chatId: message.chat_id,
          senderId: data.sender?.sender_id?.open_id || null,
          messageId: message.message_id,
          texte,
          cheminFichier,
        });

        if (reponse.texte) await envoyerTexte(client, message.chat_id, reponse.texte);
        if (reponse.fichier) await envoyerFichier(client, message.chat_id, reponse.fichier);
      } catch (erreur) {
        console.error(`[${etiquette}] Erreur message ${message.message_id} :`, erreur);
        await envoyerTexte(
          client,
          message.chat_id,
          "Desole, une erreur m'a empeche de traiter ce message. Reessaie dans un instant."
        ).catch(() => {});
      }
    },
  });

  wsClient.start({ eventDispatcher: dispatcher });
  console.log(`Adaptateur Lark demarre : ${etiquette} (${appId})`);
}

module.exports = { demarrerAdaptateur };
