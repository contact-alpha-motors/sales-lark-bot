require("dotenv").config();

// ---------------------------------------------------------------------------
// Passerelle vers les modeles, via OpenRouter
//
// Meme principe que le bot quotidien : un seul endroit porte la cle, le
// choix du modele et la reprise sur erreur. Les appelants demandent une
// TACHE, pas un modele.
//
//   CONVERSATION  porte le dialogue ET les appels d'outils. Flash-Lite
//                 suffit : il choisit des parametres, il n'ecrit jamais les
//                 donnees lui-meme. Flash coute ~6x plus cher en sortie et
//                 reste reserve a la ou il apporte quelque chose.
//   RESUME        condense la journee d'une conversation chaque soir.
//   VISION        lit un scan/photo/PDF joint a un message. C'est la seule
//                 tache qui garde Flash : lire un scan reel demande plus
//                 que du dialogue.
// ---------------------------------------------------------------------------

const BASE = process.env.IA_BASE_URL || "https://openrouter.ai/api/v1";

const MODELES = {
  CONVERSATION: process.env.IA_MODELE_CONVERSATION || "google/gemini-2.5-flash-lite",
  RESUME: process.env.IA_MODELE_RESUME || "google/gemini-2.5-flash-lite",
  VISION: process.env.IA_MODELE_VISION || "google/gemini-2.5-flash",
};

const TIMEOUTS = {
  CONVERSATION: Number(process.env.IA_TIMEOUT_CONVERSATION || 120000),
  RESUME: Number(process.env.IA_TIMEOUT_RESUME || 120000),
  VISION: Number(process.env.IA_TIMEOUT_VISION || 300000),
};

const TENTATIVES = Number(process.env.IA_TENTATIVES || 3);

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function cle() {
  const valeur = process.env.OPENROUTER_API_KEY;
  if (!valeur) {
    throw new Error("OPENROUTER_API_KEY absent de l'environnement");
  }
  return valeur;
}

function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appeler(tache, corps) {
  const modele = MODELES[tache];
  let derniereErreur;

  for (let tentative = 1; tentative <= TENTATIVES; tentative++) {
    try {
      const reponse = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cle()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: modele, ...corps }),
        signal: AbortSignal.timeout(TIMEOUTS[tache]),
      });

      if (!reponse.ok) {
        const texte = await reponse.text().catch(() => "");
        throw new Error(`OpenRouter ${reponse.status} (${modele}): ${texte.slice(0, 300)}`);
      }

      const donnees = await reponse.json();
      const message = donnees?.choices?.[0]?.message;

      if (!message) {
        throw new Error(`Reponse sans message (${modele})`);
      }

      return message;
    } catch (erreur) {
      derniereErreur = erreur;
      if (tentative < TENTATIVES) {
        await attendre(2000 * tentative);
      }
    }
  }

  throw derniereErreur;
}

// Dialogue avec outils. Retourne le message brut du modele : soit du texte,
// soit des tool_calls que l'agent executera.
async function converser(messages, outils) {
  return appeler("CONVERSATION", {
    messages,
    tools: outils,
    tool_choice: outils?.length ? "auto" : undefined,
    temperature: 0.3,
  });
}

async function resumer(instruction, texte) {
  const message = await appeler("RESUME", {
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: texte },
    ],
    temperature: 0.1,
  });
  return message.content || "";
}

// Lecture d'un fichier joint (image ou PDF) : renvoie le texte extrait.
async function lireFichier(instruction, chemin) {
  const fs = require("fs");
  const path = require("path");

  const extension = path.extname(chemin).toLowerCase();
  const mime = MIME[extension];
  if (!mime) {
    throw new Error(`Type de fichier non lisible : ${extension}`);
  }

  const base64 = fs.readFileSync(chemin).toString("base64");
  const url = `data:${mime};base64,${base64}`;

  const contenu =
    mime === "application/pdf"
      ? [{ type: "text", text: instruction }, { type: "file", file: { filename: path.basename(chemin), file_data: url } }]
      : [{ type: "text", text: instruction }, { type: "image_url", image_url: { url } }];

  const message = await appeler("VISION", {
    messages: [{ role: "user", content: contenu }],
    temperature: 0.1,
  });

  return message.content || "";
}

module.exports = { converser, resumer, lireFichier };
