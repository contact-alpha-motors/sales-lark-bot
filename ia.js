require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { disponible: popplerDispo, pdfEnImages, nettoyer } = require("./documents/pdf_en_images");
const { enregistrerAppelIa } = require("./memoire/base");

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
  VISION: process.env.IA_MODELE_VISION || "google/gemini-2.5-flash-lite",
};

const TIMEOUTS = {
  CONVERSATION: Number(process.env.IA_TIMEOUT_CONVERSATION || 120000),
  RESUME: Number(process.env.IA_TIMEOUT_RESUME || 120000),
  VISION: Number(process.env.IA_TIMEOUT_VISION || 90000),
};

const TENTATIVES = Number(process.env.IA_TENTATIVES || 3);

// Garde-fou budget : seuls ces modeles (bon marche) peuvent etre appeles.
// OpenRouter ne sait pas restreindre une cle a certains modeles ; on le fait
// ici. Tout modele hors liste est refuse AVANT tout appel paye.
const MODELES_AUTORISES = new Set(
  (process.env.IA_MODELES_AUTORISES || "z-ai/glm-5.3-flash,google/gemini-2.5-flash-lite")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

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

  if (!MODELES_AUTORISES.has(modele)) {
    throw new Error(
      `Modele non autorise par le garde-fou budget : ${modele} (tache ${tache}). ` +
      `Autorises : ${[...MODELES_AUTORISES].join(", ")}. Ajouter via IA_MODELES_AUTORISES.`
    );
  }

  let derniereErreur;

  for (let tentative = 1; tentative <= TENTATIVES; tentative++) {
    const t0 = Date.now();
    try {
      const reponse = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cle()}`,
          "Content-Type": "application/json",
        },
        // usage.include => OpenRouter renvoie le cout reel de la requete dans
        // la reponse, pas besoin d'un appel supplementaire.
        body: JSON.stringify({ model: modele, usage: { include: true }, ...corps }),
        signal: AbortSignal.timeout(TIMEOUTS[tache]),
      });

      if (!reponse.ok) {
        const texte = await reponse.text().catch(() => "");
        throw new Error(`OpenRouter ${reponse.status} (${modele}): ${texte.slice(0, 300)}`);
      }

      const donnees = await reponse.json();
      const message = donnees?.choices?.[0]?.message;
      const u = donnees?.usage || {};
      const duree = Date.now() - t0;

      tracerAppel({
        tache, modele,
        prompt_tokens: u.prompt_tokens ?? null,
        completion_tokens: u.completion_tokens ?? null,
        total_tokens: u.total_tokens ?? null,
        cout: typeof u.cost === "number" ? u.cost : null,
        duree_ms: duree,
        statut: "ok",
      });

      if (!message) {
        throw new Error(`Reponse sans message (${modele})`);
      }

      return message;
    } catch (erreur) {
      derniereErreur = erreur;
      tracerAppel({ tache, modele, duree_ms: Date.now() - t0, statut: "erreur" });
      if (tentative < TENTATIVES) {
        await attendre(2000 * tentative);
      }
    }
  }

  throw derniereErreur;
}

// Journalise et affiche un appel modele. Tolerant : la telemetrie ne doit
// jamais casser la requete.
function tracerAppel(r) {
  try {
    enregistrerAppelIa(r);
    const cout = typeof r.cout === "number" ? `$${r.cout.toFixed(6)}` : "cout=?";
    console.log(
      `[ia] ${r.statut} ${r.tache} ${r.modele} ${r.total_tokens ?? "?"}tok ${cout} ${((r.duree_ms || 0) / 1000).toFixed(1)}s`
    );
  } catch (e) {
    console.error("[ia] telemetrie:", e.message);
  }
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

function imagePart(chemin, mime) {
  const b64 = fs.readFileSync(chemin).toString("base64");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
}

// Construit le contenu multimodal pour un fichier. Un PDF est converti en
// pages PNG (via poppler) et envoye comme images : cela evite les frais
// "files" d'OpenRouter et lit mieux le manuscrit. Repli sur l'envoi du PDF
// brut si poppler est absent. Renvoie aussi une fonction de nettoyage.
async function construireContenuVision(instruction, chemin) {
  const extension = path.extname(chemin).toLowerCase();

  if (extension === ".pdf") {
    if (await popplerDispo()) {
      const { images, dossier } = await pdfEnImages(chemin);
      const parts = [{ type: "text", text: instruction }, ...images.map((img) => imagePart(img, "image/png"))];
      return { contenu: parts, nettoyage: () => nettoyer(dossier) };
    }
    // Repli : PDF brut en piece "file" (necessite du credit OpenRouter).
    const b64 = fs.readFileSync(chemin).toString("base64");
    return {
      contenu: [
        { type: "text", text: instruction },
        { type: "file", file: { filename: path.basename(chemin), file_data: `data:application/pdf;base64,${b64}` } },
      ],
      nettoyage: () => {},
    };
  }

  const mime = MIME[extension];
  if (!mime) throw new Error(`Type de fichier non lisible : ${extension}`);
  return { contenu: [{ type: "text", text: instruction }, imagePart(chemin, mime)], nettoyage: () => {} };
}

// Lecture d'un fichier joint (image ou PDF) : renvoie le texte extrait.
async function lireFichier(instruction, chemin) {
  const { contenu, nettoyage } = await construireContenuVision(instruction, chemin);
  try {
    const message = await appeler("VISION", { messages: [{ role: "user", content: contenu }], temperature: 0.1 });
    return message.content || "";
  } finally {
    nettoyage();
  }
}

function nettoyerJson(brut) {
  const bloc = brut.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (bloc ? bloc[1] : brut).trim();
}

// Lecture d'un fichier avec sortie JSON (extraction structuree). Renvoie
// l'objet parse, ou null si le modele n'a rien renvoye d'exploitable.
async function extraireFichierJson(instruction, chemin) {
  const { contenu, nettoyage } = await construireContenuVision(instruction, chemin);
  try {
    const message = await appeler("VISION", {
      messages: [{ role: "user", content: contenu }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
    try {
      return JSON.parse(nettoyerJson(message.content || "{}"));
    } catch {
      return null;
    }
  } finally {
    nettoyage();
  }
}

module.exports = { converser, resumer, lireFichier, extraireFichierJson };
