const Lark = require("@larksuiteoapi/node-sdk");
const { traiterMessage } = require("../coeur/agent");
const { claimMessage } = require("../memoire/base");
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
      if (!message) {
        console.log(`[${etiquette}] evenement recu sans message`);
        return;
      }

      console.log(
        `[${etiquette}] message recu : id=${message.message_id} type=${message.message_type} chat_type=${message.chat_type} mentions=${(message.mentions || []).length}`
      );

      try {
        // Idempotence : on reserve le message des sa reception. Lark relivre
        // un evenement non acquitte, et une extraction lente laissait
        // plusieurs traitements lourds se lancer en parallele.
        if (!claimMessage(message.message_id)) {
          console.log(`[${etiquette}] deja pris en charge, ignore`);
          return;
        }

        // En groupe, seuls les messages qui mentionnent le bot comptent.
        if (message.chat_type === "group" && !(message.mentions || []).length) {
          console.log(`[${etiquette}] groupe sans mention, ignore`);
          return;
        }

        const texte = extraireTexte(message);
        const cheminFichier = await extraireFichier(client, message);

        if (!texte && !cheminFichier) {
          console.log(`[${etiquette}] ni texte ni fichier exploitable, ignore`);
          return;
        }

        console.log(`[${etiquette}] traitement : "${texte.slice(0, 60)}"${cheminFichier ? " +fichier" : ""}`);

        const reponse = await traiterMessage({
          chatId: message.chat_id,
          senderId: data.sender?.sender_id?.open_id || null,
          messageId: message.message_id,
          texte,
          cheminFichier,
        });

        if (reponse.texte) await envoyerTexte(client, message.chat_id, reponse.texte);
        if (reponse.fichier) await envoyerFichier(client, message.chat_id, reponse.fichier);
        console.log(`[${etiquette}] reponse envoyee${reponse.fichier ? " (+fichier)" : ""}`);
      } catch (erreur) {
        console.error(`[${etiquette}] Erreur message ${message.message_id} :`, erreur);
        // Message clair quand c'est Odoo qui est injoignable (ex. HTTP 530),
        // pour ne pas laisser croire que le bot est casse.
        const msg = /Odoo HTTP|Odoo:|ECONN|ETIMEDOUT|timeout|530|502|503|504/i.test(erreur?.message || "")
          ? "Odoo est momentanement injoignable (serveur CRM). Reessaie dans quelques minutes — ce n'est pas le bot."
          : "Desole, une erreur m'a empeche de traiter ce message. Reessaie dans un instant.";
        await envoyerTexte(client, message.chat_id, msg).catch(() => {});
      }
    },
  });

  wsClient.start({ eventDispatcher: dispatcher });
  console.log(`Adaptateur Lark demarre : ${etiquette} (${appId})`);
}

module.exports = { demarrerAdaptateur };
