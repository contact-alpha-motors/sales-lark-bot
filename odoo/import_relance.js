const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { rechercherLire } = require("./rpc");
const { chercherParTelephone, resoudreUtilisateur } = require("./requetes");
const { normaliserTelephone, telephoneValide, detecterDate, analyserResultat } = require("../coeur/referentiel");
const { classifierResultats, verdictDeSaisie } = require("../coeur/classifieur");
const { extraireFichierJson } = require("../ia");
const { enregistrerOcr, lireOcr } = require("../memoire/base");
const { disponible: popplerDispo, pdfEnImages, nettoyer } = require("../documents/pdf_en_images");

function aujourdhuiCmr() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}
function archiverImages(dossierCible, images) {
  try {
    fs.mkdirSync(dossierCible, { recursive: true });
    images.forEach((img, i) => fs.copyFileSync(img, path.join(dossierCible, `page-${String(i + 1).padStart(2, "0")}.png`)));
  } catch (e) {
    console.error("[ocr] archivage images:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Import des fiches "RAPPORT DES RECEPTIONS CLIENTS — LISTE D'APPELS : <agent>"
// (un commercial relance par telephone d'anciennes receptions showroom).
//
// Tableau IMPRIME (nom, tel, date reception, vehicule, origine, agent) +
// COMMENTAIRE manuscrit qui porte le resultat. Une date de session peut etre
// griffonnee sur la page : c'est la date d'appel appliquee a ses lignes.
// ---------------------------------------------------------------------------

const INSTRUCTION_PAGE = `Ceci est UNE page d'un "RAPPORT DES RECEPTIONS CLIENTS - LISTE D'APPELS", un tableau IMPRIME ou un commercial relance par telephone d'anciens clients recus au showroom. Le seul manuscrit est la colonne Commentaire et, parfois, une DATE griffonnee a part sur la page (= date des appels de cette page).
Renvoie UNIQUEMENT du JSON, cette forme exacte :
{
  "type_fiche": "reception" si le titre est bien un rapport de receptions / liste d'appels imprime, sinon "autre",
  "agent": "<nom apres 'LISTE D'APPELS :' ou colonne 'Agent charge de l'appel'>",
  "date_session_brut": "<date manuscrite isolee sur la page (ex '29/09/2026'), sinon ''>",
  "lignes": [
    {
      "nom": "<Nom du client (imprime)>",
      "telephone": "<Telephone (imprime), chiffres>",
      "date_reception": "<Date de reception imprimee>",
      "origine": "<colonne Origine>",
      "vehicules": "<colonne Vehicules d'interet>",
      "agent_ligne": "<valeur de la colonne 'Agent charge de l'appel' pour cette ligne>",
      "commentaire": "<le commentaire MANUSCRIT, transcrit fidelement>"
    }
  ]
}
Lis TOUTES les lignes de CETTE page. Ne corrige pas les numeros. Info absente = "".`;

// Le resultat de la relance est en texte libre (manuscrit, souvent mal OCR).
// Regle : on NE JETTE JAMAIS une ligne. Si le code n'est pas clair, on importe
// quand meme un appel avec le commentaire garde et un tag "a categoriser".
// Patterns tolerants aux fautes d'OCR (RDY, RELA..., RELIEN, HRP, KIHA...).
// Concurrents connus (variante OCR courte -> nom propre pour l'etiquette).
const CONCURRENTS = [
  ["SKY", "Sky Motors"], ["ABN", "ABN Motors"], ["TRACTAFRIC", "Tractafric"],
  ["CAMI", "CAMI Toyota"], ["TOYOTA", "CAMI Toyota"], ["CFAO", "CFAO"],
];

// Detecte un CONCURRENT dans un commentaire, de maniere ROBUSTE a l'OCR : le
// nom manuscrit de la marque est souvent mal lu (ex "Sky Motors" lu "shymono"),
// donc on ne se fie pas qu'aux noms connus.
//   1) nom connu cite         -> nom propre normalise (Sky Motors, CFAO...)
//   2) "chez X"               -> on capte X tel quel (shymono, Sky Motors...)
//   3) perte "...ailleurs"    -> "(a preciser)" (concurrent sur, nom illisible)
// Renvoie null si aucun signe de concurrent.
function detecterConcurrent(commentaire) {
  const t = String(commentaire || "");
  const T = t.toUpperCase();
  // 1) Concurrent connu cite (matche meme au sein d'un mot mal lu).
  const connu = CONCURRENTS.find(([k]) => T.includes(k));
  if (connu) return connu[1];
  // 2) Il faut un SIGNAL DE PERTE pour eviter les faux positifs ("chez lui",
  //    "chez moi", "rappeler chez lui demain").
  const perte = /(SATISFACTION|ACHET[EÉ]|ACHAT|TROUV[EÉ]|PRIS|COMMAND[EÉ]|CONCURRENT|AILLEURS)/.test(T);
  if (!perte) return null;
  // 3) "chez X" -> on capte UN mot (la marche, ex "shymono"), sans happer la
  //    suite ("... demain"). Les pronoms/articles ne sont pas des concurrents.
  const chez = t.match(/\bchez\s+([\p{L}0-9][\p{L}0-9'’.\-]{1,24})/iu);
  if (chez) {
    const nom = chez[1].replace(/[)\].,;:].*$/su, "").trim();
    if (nom && !/^(lui|elle|eux|nous|moi|toi|vous|un|une|le|la|les|son|sa|ses|mon|ma)$/i.test(nom)) return nom;
  }
  // 4) Perte claire mais marque illisible -> a preciser par un humain.
  return "(à préciser)";
}

function analyserCommentaireRelance(commentaire) {
  const t = (commentaire || "").toUpperCase();
  if (!t.replace(/[^A-Z0-9]/g, "")) return { statut: "vide" }; // aucun texte -> pas d'appel

  const whatsapp = /WHATSA|\bWHA\b|KIHA|\bKHA\b|\bWA\b/.test(t);
  const dateCom = detecterDate(commentaire);

  if (/RD[VY]|RENDEZ|SHOWROO/.test(t)) {
    const video = /VID[EÉ]O|VISIO/.test(t);
    return { statut: "ok", event_type: video ? "video_call" : "call", sous_type: video ? "video_meeting_booked" : "meeting_booked", rdv_date: dateCom, whatsapp };
  }

  // A DEJA ACHETE : achat AVERE (pas une intention « veut acheter »). Chez un
  // concurrent -> on ressort le concurrent exact via une etiquette dediee.
  const veutAcheter = /(VEUT|VA|SOUHAIT|COMPTE|AIMERAIT|DESIRE|PROJET|POUR)\s*D?['’]?\s*ACHET/.test(t);
  if (!veutAcheter && /(A\s*ACHET|DEJA\s*ACHET|ACHET[EÉ]|ACHAT|A\s*PRIS\s*(SA|UN|UNE|LE))/.test(t)) {
    const conc = detecterConcurrent(commentaire);
    const tags = ["Déjà acheté"];
    let note = "Déjà acheté";
    if (conc) { tags.push("Concurrent", conc); note = `Acheté chez ${conc} (concurrent)`; }
    return { statut: "ok", event_type: "call", sous_type: "client", note, tags, whatsapp };
  }

  if (/RELA|RAPPEL/.test(t) && !whatsapp) {
    return { statut: "ok", event_type: "call", sous_type: "call_back", callback_date: dateCom, whatsapp };
  }
  if (/REVIEN|RELIEN|NOUS\s*R|PASSERA|REPASSE/.test(t)) return { statut: "ok", event_type: "call", sous_type: "wiil_come_back", whatsapp };

  // Hors ville / a voyage / demenage : injoignable, avec etiquette.
  if (/PLUS\s*(DANS|EN)\s*L?A?\s*VILLE|HORS\s*(DE\s*)?(LA\s*)?VILLE|VOYAG|DEMENAG|D[EÉ]M[EÉ]NAG/.test(t)) {
    return { statut: "ok", event_type: "call", sous_type: "not_online", note: "Hors ville", tags: ["Hors ville"], whatsapp };
  }

  if (/NPI|NLP|PAS\s*INT/.test(t)) return { statut: "ok", event_type: "call", sous_type: "not_interested", whatsapp };
  if (/N[RH]P|HRP|NHA|MRB|NRB/.test(t)) return { statut: "ok", event_type: "call", sous_type: "no_answer", whatsapp };
  if (whatsapp) return { statut: "ok", event_type: "message", sous_type: null, note: "Relance WhatsApp", whatsapp };
  if (/PROFORMA|PRO\s*FORMA/.test(t)) return { statut: "ok", event_type: "call", sous_type: "interested", note: "Proforma", tags: ["Proforma"], whatsapp };

  // Commentaire = juste une date (« 29/09/2026 », « relance le 01-10 ») : c'est
  // un rappel programme, pas un « a categoriser ».
  if (dateCom) return { statut: "ok", event_type: "call", sous_type: "call_back", callback_date: dateCom, note: `Rappel prevu ${dateCom}`, whatsapp };

  // Non categorise : importe quand meme, commentaire garde, marque a revoir.
  return { statut: "ok", event_type: "call", sous_type: null, note: "A categoriser", whatsapp, non_categorise: true };
}

function fusionner(pages) {
  const ok = pages.filter(Boolean);
  const entete = ok.find((p) => p.agent) || {};
  return {
    type_fiche: ok.find((p) => p.type_fiche)?.type_fiche || "autre",
    agent: entete.agent || "",
    // On garde la date de session par page pour la porter sur ses lignes, le
    // numero de page (ordre de lecture) ET le rang de la ligne DANS sa page,
    // pour pouvoir pointer une ligne precise a l'utilisateur ("page 2, ligne 7").
    lignes: ok.flatMap((p, idx) =>
      (p.lignes || []).map((l, r) => ({ ...l, date_session_brut: p.date_session_brut || "", _page: idx + 1, _rang: r + 1 }))
    ),
  };
}

async function extraireFicheReception(chemin) {
  // Meme cache par empreinte que les fiches d'appel : un scan deja lu est repris
  // (0 cout). Cache commun ocr_cache, l'extraction porte type_fiche.
  const octets = fs.readFileSync(chemin);
  const hash = crypto.createHash("sha256").update(octets).digest("hex");
  const cache = lireOcr(hash);
  const visionActuel = process.env.IA_MODELE_VISION || "google/gemini-2.5-flash-lite";
  if (cache) {
    try {
      const r = JSON.parse(cache.extraction);
      // On n'utilise le cache que s'il porte le schema courant (agent par ligne)
      // ET s'il a ete produit par le modele vision actuel ; sinon on re-extrait.
      if (r && r.type_fiche === "reception" && r.lignes && r.lignes[0] && "agent_ligne" in r.lignes[0] && cache.modele === visionActuel) {
        console.log(`[ocr] cache hit ${hash.slice(0, 8)} (reception, modele ${cache.modele})`);
        return r;
      }
    } catch { /* relire */ }
  }

  let resultat;
  const ext = path.extname(chemin).toLowerCase();
  if (ext === ".pdf" && (await popplerDispo())) {
    const { images, dossier } = await pdfEnImages(chemin);
    try {
      // Lecture SEQUENTIELLE (pas Promise.all) : evite que les pages se
      // starvent sur un modele vision lent et depassent le timeout.
      const pages = [];
      for (const img of images) {
        pages.push(await extraireFichierJson(INSTRUCTION_PAGE, img).catch(() => null));
      }
      resultat = fusionner(pages);
      const corpus = path.join(process.env.OCR_IMAGES_DIR || path.join(__dirname, "..", "data", "ocr_images"), hash);
      archiverImages(corpus, images);
    } finally {
      nettoyer(dossier);
    }
  } else {
    resultat = fusionner([await extraireFichierJson(INSTRUCTION_PAGE, chemin)]);
  }

  // On ne met en cache QUE si c'est bien une reception (sinon on laisse la voie
  // fiche d'appel gerer et cacher a sa maniere).
  if (resultat && resultat.type_fiche === "reception") {
    try {
      enregistrerOcr({
        hash, fichier: path.basename(chemin).replace(/^\d+-/, ""),
        extraction: JSON.stringify(resultat), modele: process.env.IA_MODELE_VISION || "",
        nb_lignes: resultat.lignes ? resultat.lignes.length : 0,
      });
    } catch (e) { console.error("[ocr] cache reception:", e.message); }
  }
  return resultat;
}

const resoudreAgent = resoudreUtilisateur;

async function construirePlanRelance(extraction, indice = "") {
  const agentUser = await resoudreAgent(extraction.agent);
  // Les fiches sont ordonnees par sections d'agent : une cellule d'agent vide
  // ou mal lue herite du dernier agent resolu (le commercial de la section).
  let dernierAgent = agentUser;
  const plan = {
    type: "relance",
    ocr_hash: extraction.hash || null,
    agent: extraction.agent || null,
    agent_id: agentUser ? agentUser.id : null,
    // Date d'appel par defaut : celle de l'indice (legende/nom fichier), sinon
    // aujourd'hui. Chaque ligne peut la surcharger via sa date de session.
    event_date: `${detecterDate(indice) || aujourdhuiCmr()} 12:00:00`,
    actions: [],
    vides: [],
    invalides: [],
    sans_date: [], // lignes NON importees faute de date d'appel (page a dater)
    a_revoir: [], // lignes importees mais a confirmer (classement peu sur)
  };

  // --- CLASSEMENT type-safe (jev), en UN seul appel pour toute la fiche ---
  // L'OCR a transcrit le resultat BRUT ; jev le range dans une categorie avec
  // une confiance. Au-dessus du seuil on ecrit d'office ; en dessous on marque
  // "a revoir" en PROPOSANT le meilleur choix. Si jev est indisponible, on
  // replie ligne par ligne sur la regle locale analyserResultat.
  const lignesAClasser = (extraction.lignes || []).filter((l) => l.resultat && String(l.resultat).trim());
  const verdictParLigne = new Map();
  if (lignesAClasser.length) {
    try {
      const verdicts = await classifierResultats(
        lignesAClasser.map((l) => ({ resultat_brut: l.resultat, commentaire: l.commentaire }))
      );
      lignesAClasser.forEach((l, i) => verdictParLigne.set(l, verdicts[i]));
    } catch (e) {
      console.error("[classif] jev indisponible, repli regle locale:", e.message);
    }
  }

  for (const ligne of extraction.lignes || []) {
    const tel = normaliserTelephone(ligne.telephone);
    const res = analyserCommentaireRelance(ligne.commentaire);

    // Feuille de relance IMPRIMEE (NR/NRP) : le resultat du jour est un CODE
    // manuscrit dans sa propre colonne (PI, NR, NRP, RDV, PL...). On le classe
    // avec le lecteur de codes (fiable), tout en gardant les etiquettes
    // deduites du commentaire (concurrent, deja achete, hors ville...).
    if (ligne.resultat && String(ligne.resultat).trim()) {
      // Verdict jev (pre-classe en batch) ; a defaut, regle locale.
      const c = verdictParLigne.get(ligne) || analyserResultat(ligne.resultat, ligne.commentaire);
      if (c.statut === "ok") {
        res.statut = "ok";
        res.event_type = c.event_type;
        res.sous_type = c.sous_type;
        res.non_categorise = false;
        res.a_revoir = false;
        if (!res.note && c.note) res.note = c.note;
        if (c.tag) res.tags = [...(res.tags || []), c.tag];
      } else {
        // Code du jour non tranche (confiance < seuil, illisible, ou hors
        // commercial). Si le COMMENTAIRE a deja donne une categorie claire, on
        // la garde ; sinon "a revoir" en PROPOSANT le meilleur choix de jev.
        const commentaireAClasse = res.statut === "ok" && !res.non_categorise;
        if (!commentaireAClasse) {
          res.statut = "ok"; res.event_type = "call"; res.sous_type = null;
          res.non_categorise = true; res.a_revoir = true;
          const sugg = c.propose && c.propose.categorie;
          const conf = c.confiance != null ? ` ${Math.round(c.confiance * 100)}%` : "";
          res.note = c.statut === "routage"
            ? (c.note || "Hors commercial (DP/DE)")
            : sugg ? `À revoir — suggéré : ${sugg}${conf}` : "À revoir (classement incertain)";
          res.suggestion = sugg || null;
        }
      }
      // Numero marque incorrect/faux sur la feuille -> faux numero.
      if (/INCORRECT|FAUX\s*NUM|N[' ]?EXISTE/.test((ligne.resultat || "").toUpperCase())) {
        res.statut = "ok"; res.event_type = "call"; res.sous_type = "bad_number"; res.non_categorise = false; res.a_revoir = false;
      }
    }

    // --- CONCURRENT : detection robuste, appliquee a TOUTE ligne ---
    // On ne rate plus une perte concurrent meme si le modele a mal lu la marque
    // (nom connu, "chez X" capte tel quel, ou perte "ailleurs" -> a preciser).
    const conc = detecterConcurrent(ligne.commentaire);
    if (conc) {
      const tg = new Set(res.tags || []);
      tg.add("Concurrent");
      tg.add(conc);
      // Achat AVERE chez un concurrent -> Deja achete (sauf si un RDV a ete pris).
      if (/A\s*ACHET|ACHET[EÉ]\s*(AILLEURS|CHEZ)|DEJA\s*ACHET/.test((ligne.commentaire || "").toUpperCase())
          && res.sous_type !== "meeting_booked" && res.sous_type !== "video_meeting_booked") {
        tg.add("Déjà acheté");
        res.sous_type = "client";
      }
      res.tags = [...tg];
      if (!res.note || res.note === "A categoriser") res.note = `Concurrent ${conc}`;
      res.non_categorise = false;
    }
    // Date de RDV portee par sa propre colonne sur les feuilles imprimees.
    if (!res.rdv_date && ligne.date_rdv) {
      let dr = detecterDate(ligne.date_rdv);
      // Fourchette de jours ("19-20/10/26", "19/20/10/26", "19 au 20/10") : non
      // lisible telle quelle -> on prend le jour le PLUS PROCHE (le premier).
      if (!dr) {
        const norm = String(ligne.date_rdv).replace(/(\d{1,2})\s*(?:-|\/|a|au)\s*\d{1,2}([\/-]\s*\d{1,2})/i, "$1$2");
        dr = detecterDate(norm);
      }
      if (dr) res.rdv_date = dr;
    }

    if (res.statut === "vide") {
      plan.vides.push({ nom: ligne.nom, telephone: tel });
      continue;
    }
    if (!telephoneValide(tel)) {
      plan.invalides.push({ nom: ligne.nom, telephone: ligne.telephone });
      continue;
    }

    // Date d'appel = date de session griffonnee sur la page ; sinon l'indice
    // (legende/nom de fichier). Sans date, on NE DEVINE PAS : la ligne est mise
    // de cote et la page signalee, pour qu'une vraie date soit ajoutee.
    const dateSession = detecterDate(ligne.date_session_brut) || detecterDate(indice);
    if (!dateSession) {
      plan.sans_date.push({ nom: ligne.nom, telephone: tel, page: ligne._page || null });
      continue;
    }
    // Agent PAR LIGNE (colonne "Agent charge de l'appel") : gere les paquets
    // multi-commerciaux. Cellule vide/mal lue -> herite du dernier agent resolu.
    const agentLigne = ligne.agent_ligne ? await resoudreAgent(ligne.agent_ligne) : null;
    if (agentLigne) dernierAgent = agentLigne;
    const agentEffectif = agentLigne || dernierAgent;
    const existantes = await chercherParTelephone(tel);
    const piste = existantes[0] || null;

    const notes = [
      ligne.commentaire || "",
      res.note ? `[${res.note}]` : "",
      res.whatsapp && res.event_type !== "message" ? "[relance WhatsApp]" : "",
      ligne.vehicules ? `Vehicule: ${ligne.vehicules}` : "",
      ligne.date_reception ? `Recu le ${ligne.date_reception}` : "",
      ligne.origine ? `Origine: ${ligne.origine}` : "",
      `(relance ${plan.agent || "?"})`,
    ].filter(Boolean).join(" ").trim();

    const action = {
      nom: (ligne.nom || "").trim(),
      telephone: tel,
      piste_id: piste ? piste.id : null,
      piste_nom: piste ? piste.contact_name || piste.name : null,
      nouvelle_piste: !piste,
      event_type: res.event_type,
      sous_type: res.sous_type,
      event_date: dateSession ? `${dateSession} 12:00:00` : null,
      agent_id: agentEffectif ? agentEffectif.id : null,
      agent_nom: agentEffectif ? agentEffectif.name : (ligne.agent_ligne || plan.agent || "?"),
      non_categorise: !!res.non_categorise,
      a_revoir: !!res.a_revoir, // classement peu sur : ecrit mais a confirmer
      suggestion: res.suggestion || null, // categorie proposee par jev (a confirmer)
      page: ligne._page || null,
      rang: ligne._rang || null,
      tags: res.tags || null, // etiquettes crm.tag (Deja achete, Concurrent, Hors ville, Proforma...)
      notes,
      rdv: null,
    };

    if (res.sous_type === "meeting_booked" || res.sous_type === "video_meeting_booked") {
      if (res.rdv_date) action.rdv = { date: res.rdv_date, resume: `RDV: ${action.nom || tel}` };
    } else if (res.sous_type === "call_back" && res.callback_date) {
      action.rdv = { date: res.callback_date, resume: `Relance prevue: ${action.nom || tel}` };
    }

    plan.actions.push(action);
    // Ligne "a revoir" : on garde un pointeur (index dans plan.actions) + le
    // repere physique (page, rang) pour que l'utilisateur confirme/corrige.
    if (res.a_revoir) {
      plan.a_revoir.push({
        ref: plan.a_revoir.length + 1,
        action_index: plan.actions.length - 1,
        nom: action.nom, telephone: tel,
        brut: ligne.resultat || "", suggestion: res.suggestion || null,
        page: ligne._page || null, rang: ligne._rang || null,
      });
    }
  }

  plan.resume = {
    total_lignes: (extraction.lignes || []).length,
    a_ecrire: plan.actions.length,
    nouvelles_pistes: plan.actions.filter((a) => a.nouvelle_piste).length,
    rdv: plan.actions.filter((a) => a.rdv).length,
    whatsapp: plan.actions.filter((a) => a.event_type === "message").length,
    non_categorises: plan.actions.filter((a) => a.non_categorise).length,
    a_revoir: plan.a_revoir.length,
    vides: plan.vides.length,
    invalides: plan.invalides.length,
    sans_date: plan.sans_date.length,
    // Pages (ordre de lecture) qui n'ont aucune date d'appel -> a dater.
    pages_sans_date: [...new Set(plan.sans_date.map((l) => l.page).filter(Boolean))].sort((a, b) => a - b),
  };
  // Repartition par agent (le fichier peut etre un paquet de plusieurs commerciaux).
  const parAgent = {};
  for (const a of plan.actions) {
    const nom = a.agent_nom || "?";
    if (!parAgent[nom]) parAgent[nom] = { n: 0, resolu: !!a.agent_id };
    parAgent[nom].n += 1;
  }
  plan.par_agent = parAgent;
  return plan;
}

function resumePlanRelance(plan) {
  const r = plan.resume;
  const agents = Object.entries(plan.par_agent || {});
  const enTete = agents.length > 1 ? "plusieurs commerciaux" : (agents[0] ? agents[0][0] : plan.agent || "?");
  const lignes = [
    `Fiche de relance (receptions) — ${enTete} :`,
    `- ${r.total_lignes} lignes lues`,
    `- ${r.a_ecrire} appels a enregistrer, dont ${r.nouvelles_pistes} nouvelles pistes, ${r.rdv} RDV/relances datees, ${r.whatsapp} relances WhatsApp`,
  ];
  // Detail par commercial (utile pour un paquet).
  if (agents.length) {
    lignes.push("- Par commercial :");
    for (const [nom, info] of agents.sort((a, b) => b[1].n - a[1].n)) {
      lignes.push(`   • ${nom} : ${info.n}${info.resolu ? "" : " (non retrouve dans Odoo, non attribue)"}`);
    }
  }
  // "A categoriser" purs (sans suggestion) = non_categorises moins les "a revoir".
  const nonCatPurs = Math.max(0, (r.non_categorises || 0) - (r.a_revoir || 0));
  if (nonCatPurs) lignes.push(`- ${nonCatPurs} commentaires importes mais « a categoriser » (code peu clair, texte garde)`);
  if (r.a_revoir) {
    lignes.push(`- 🔎 ${r.a_revoir} lignes À REVOIR (classement incertain) — NON tranchees, a confirmer :`);
    for (const l of (plan.a_revoir || [])) {
      const ou = l.page ? `page ${l.page}, ligne ${l.rang}` : `ligne ${l.rang || "?"}`;
      lignes.push(`   #${l.ref} — ${ou} — ${l.nom || l.telephone} : lu « ${l.brut || "?"} »${l.suggestion ? ` → suggere « ${l.suggestion} »` : ""}`);
    }
    lignes.push(
      "   ↳ Donne-moi les vraies valeurs, ex : « #1 NR #2 RDV » (codes : NR, NRP, PI, RDV, PL, BL, ND, DP…).",
      "     Puis « oui » pour enregistrer. Un simple « oui » garde ces lignes « a categoriser »."
    );
  }
  if (r.vides) lignes.push(`- ${r.vides} lignes sans commentaire ignorees`);
  if (r.invalides) lignes.push(`- ${r.invalides} numeros invalides ignores`);
  if (r.sans_date) {
    const pages = r.pages_sans_date && r.pages_sans_date.length ? ` (pages ${r.pages_sans_date.join(", ")})` : "";
    lignes.push(`- ⚠️ ${r.sans_date} lignes SANS date d'appel${pages} : NON importees. Ecris une date sur ces pages, ou renvoie le fichier avec la date dans le message.`);
  }
  lignes.push("", 'J\'enregistre les lignes datees dans Odoo ? Reponds "oui" pour confirmer, "non" pour annuler.');
  return lignes.join("\n");
}

// --- CORRECTIONS humaines des lignes "a revoir" --------------------------
// L'utilisateur repond avec les vraies valeurs, ex : "#1 NR  #2 RDV". On
// reconnait "#n <code>", "ligne n <code>", "n=<code>". <code> = code manuscrit
// (NR, NRP, PI, RDV, PL, BL, ND, DP…) ou libelle de categorie ("Nous revient").
const RE_CORRECTION = /(?:#|n[°o]\.?|ligne)\s*(\d{1,3})\s*[:=\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ ]{0,24})|(\d{1,3})\s*[:=]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ ]{0,24})/gi;

function contientCorrections(texte) {
  RE_CORRECTION.lastIndex = 0;
  return RE_CORRECTION.test(String(texte || ""));
}

// Applique les corrections au plan (mutation) : tranche les lignes visees et
// les retire de la liste "a revoir". Renvoie un compte-rendu.
function appliquerCorrections(plan, texte) {
  const appliquees = [];
  const inconnues = [];
  if (!plan || !Array.isArray(plan.a_revoir)) return { appliquees, inconnues };
  const s = String(texte || "");
  RE_CORRECTION.lastIndex = 0;
  let m;
  while ((m = RE_CORRECTION.exec(s))) {
    const ref = Number(m[1] || m[3]);
    const brut = (m[2] || m[4] || "").trim();
    const entry = plan.a_revoir.find((x) => x.ref === ref);
    if (!entry) { inconnues.push({ ref, raison: "numero inconnu" }); continue; }
    // Essaie la saisie entiere, puis le premier mot (si "RDV oui").
    const v = verdictDeSaisie(brut) || verdictDeSaisie(brut.split(/\s+/)[0] || "");
    if (!v) { inconnues.push({ ref, saisie: brut, raison: "code non reconnu" }); continue; }
    const a = plan.actions[entry.action_index];
    if (!a) { inconnues.push({ ref, raison: "ligne absente" }); continue; }

    if (v.statut === "routage") {
      // Hors commercial (DP/DE) : pas de sous-type a ecrire, on le note.
      a.sous_type = null; a.event_type = "call"; a.non_categorise = true;
      a.note_correction = "Hors commercial (DP/DE)";
    } else {
      a.sous_type = v.sous_type; a.event_type = v.event_type || "call";
      a.non_categorise = false;
    }
    a.a_revoir = false; a.suggestion = null;
    a.notes = `${a.notes || ""} [corrige: ${v.categorie}]`.trim();
    // RDV corrige sans date connue -> evenement cree, calendrier seulement si date.
    if ((v.sous_type === "meeting_booked" || v.sous_type === "video_meeting_booked") && !a.rdv) {
      a.rdv = null; // pas de date fournie ; l'evenement garde le sous-type RDV
    }
    appliquees.push({ ref, categorie: v.categorie, nom: a.nom || a.telephone });
  }
  // Retire les lignes corrigees de la liste "a revoir" et recompte.
  const refsOK = new Set(appliquees.map((x) => x.ref));
  plan.a_revoir = plan.a_revoir.filter((x) => !refsOK.has(x.ref));
  if (plan.resume) {
    plan.resume.a_revoir = plan.a_revoir.length;
    plan.resume.non_categorises = plan.actions.filter((a) => a.non_categorise).length;
    plan.resume.rdv = plan.actions.filter((a) => a.rdv).length;
  }
  return { appliquees, inconnues };
}

module.exports = {
  extraireFicheReception, analyserCommentaireRelance, construirePlanRelance,
  resumePlanRelance, contientCorrections, appliquerCorrections,
};
