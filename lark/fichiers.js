const fs = require("fs");
const path = require("path");

const DOSSIER = process.env.DOWNLOADS_DOSSIER || path.join(__dirname, "..", "downloads");

// Telechargement d'une piece jointe d'un message Lark (image ou fichier).
async function telechargerPieceJointe(client, messageId, fileKey, type, nomFichier) {
  fs.mkdirSync(DOSSIER, { recursive: true });

  const reponse = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  const chemin = path.join(DOSSIER, `${Date.now()}-${nomFichier}`);
  await reponse.writeFile(chemin);
  return chemin;
}

async function envoyerTexte(client, chatId, texte) {
  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: texte }),
    },
  });
}

// Envoi d'un fichier local dans une conversation. Meme mecanique que la
// publication des rapports du bot quotidien : upload puis message "file".
async function envoyerFichier(client, chatId, chemin) {
  const extension = path.extname(chemin).toLowerCase().replace(".", "");
  const typesLark = { xlsx: "xls", xls: "xls", pdf: "pdf", doc: "doc", docx: "doc" };

  const upload = await client.im.v1.file.create({
    data: {
      file_type: typesLark[extension] || "stream",
      file_name: path.basename(chemin),
      file: fs.createReadStream(chemin),
    },
  });

  const fileKey = upload?.file_key;
  if (!fileKey) {
    throw new Error("Upload Lark sans file_key");
  }

  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
}

module.exports = { telechargerPieceJointe, envoyerTexte, envoyerFichier };
