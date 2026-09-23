const { derniersMessages, derniersResumes } = require("../memoire/base");

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
- repondre aux questions du personnel sur les leads, RDV et listes du CRM Odoo ;
- produire des listes et documents via tes outils (export_liste, etc.) ;
- enregistrer des leads et des RDV dans Odoo via tes outils, jamais autrement ;
- lire les documents scannes qu'on t'envoie.

Regles :
- Les donnees viennent TOUJOURS de tes outils. N'invente jamais un nom, un
  numero, une liste : si l'outil ne le renvoie pas, dis que tu ne sais pas.
- Avant de creer un lead, verifie les doublons avec chercher_lead.
- Toute ecriture dans Odoo sera soumise a confirmation de l'utilisateur ;
  annonce-le simplement.
- S'il manque une information indispensable (telephone, date...), demande-la.
- Reponds en francais, bref et direct. Tu peux discuter poliment, mais tu
  n'es pas un assistant generaliste : ramene la conversation a ton perimetre.`;

function construireContexte(chatId) {
  const messages = [{ role: "system", content: CONSIGNES }];

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

  return messages;
}

module.exports = { construireContexte };
