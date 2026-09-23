const { resumer } = require("../ia");
const {
  chatsActifsDuJour,
  messagesDuJour,
  enregistrerResume,
} = require("../memoire/base");

// ---------------------------------------------------------------------------
// Le compresseur de contexte : chaque soir, la journee de chaque conversation
// est condensee en un paragraphe garde en base. C'est ce resume — et non les
// messages bruts — qui sera renvoye au modele les jours suivants.
// ---------------------------------------------------------------------------

const INSTRUCTION = `Tu condenses la journee d'une conversation entre le personnel d'Alpha Motors et son assistant commercial. Garde uniquement les FAITS utiles pour les jours suivants : qui a demande quoi, quelles listes ont ete produites, quels leads/RDV ont ete crees (avec leurs numeros Odoo), quelles demandes restent en suspens. Ignore les politesses. Un paragraphe, 120 mots maximum, en francais.`;

function jourLocal(decalageJours = 0) {
  const d = new Date(Date.now() + 3600 * 1000 - decalageJours * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

async function resumerLaJournee(jour = jourLocal()) {
  const chats = chatsActifsDuJour(jour);

  for (const chatId of chats) {
    const messages = messagesDuJour(chatId, jour);
    if (messages.length < 2) continue;

    const texte = messages
      .map((m) => `${m.role === "assistant" ? "Assistant" : "Utilisateur"}: ${m.contenu || ""}`)
      .join("\n");

    try {
      const resume = await resumer(INSTRUCTION, texte.slice(0, 60000));
      if (resume.trim()) enregistrerResume(chatId, jour, resume.trim());
    } catch (erreur) {
      console.error(`Resume impossible pour ${chatId} (${jour}):`, erreur.message);
    }
  }

  return chats.length;
}

// Lancable a la main : node coeur/resumeur.js [AAAA-MM-JJ]
if (require.main === module) {
  require("dotenv").config();
  resumerLaJournee(process.argv[2] || jourLocal()).then((n) =>
    console.log(`${n} conversation(s) parcourue(s).`)
  );
}

module.exports = { resumerLaJournee, jourLocal };
