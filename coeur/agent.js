const path = require("path");
const { converser, lireFichier } = require("../ia");
const { construireContexte } = require("./contexte");
const { OUTILS, schemas } = require("./outils");
const { peutExecuter } = require("./droits");
const { extraireFeuilleAppel, construirePlan, resumePlan, completerEntete, stagerPlan } = require("../odoo/import_appels");
const { extraireFicheReception, construirePlanRelance, resumePlanRelance, contientCorrections, appliquerCorrections } = require("../odoo/import_relance");
const { lignesRdvDuJour, lignesLapins, aujourdhuiCmr } = require("../odoo/fiches_rdv");
const { genererFicheAppel } = require("../documents/fiche_appel_pdf");
const { extraireFicheRdv, construirePlanFicheRdv, resumePlanFicheRdv } = require("../odoo/import_fiche_rdv");
const {
  enregistrerMessage,
  poserActionEnAttente,
  lireActionEnAttente,
  prendreActionEnAttente,
  journaliser,
  resoudreFiches,
  purgerHashes,
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

// Une proposition en attente n'est valable qu'un temps : au-dela, un « oui »
// tardif ne doit PLUS declencher une vieille action (ex. un import laisse en
// suspens pendant qu'on parlait d'autre chose).
const EXPIRATION_ATTENTE_MS = 15 * 60 * 1000; // 15 min

// Mots qui, SEULS, forment une confirmation / une annulation.
const MOT_CONFIRME = /^(oui|ouais|ouaip|ok|okay|d'?accord|dac|confirme[rz]?|valide[rz]?|vas-?y|go|yes|yep)$/i;
const MOT_ANNULE = /^(non|nan|annule[rz]?|stop|no|laisse|abandonne|oublie)$/i;
// Mots de remplissage toleres autour d'un « oui » sans en changer le sens.
const MOT_FILLER = /^(et|puis|alors|donc|bien|s[uû]r|stp|svp|merci|c'?est|bon|ca|ça|le|la|maintenant|fais|fais-?le|enregistre[rz]?|importe[rz]?|please|now|tout)$/i;

// Decoupe en mots (ponctuation retiree). Une CONFIRMATION = le 1er mot est un
// « oui » ET tous les autres sont des « oui »/remplissage. Ainsi « oui » et
// « ok vas-y » confirment, mais « oui, en pdf ça serait bien » N'EST PAS une
// confirmation : c'est une nouvelle demande, qui part au modele.
function motsDe(texte) {
  return String(texte || "").toLowerCase().replace(/[.,!?;:()"]/g, " ").split(/\s+/).filter(Boolean);
}
function estConfirmation(texte) {
  const m = motsDe(texte);
  return m.length > 0 && MOT_CONFIRME.test(m[0]) && m.slice(1).every((t) => MOT_CONFIRME.test(t) || MOT_FILLER.test(t));
}
function estAnnulation(texte) {
  const m = motsDe(texte);
  return m.length > 0 && MOT_ANNULE.test(m[0]) && m.slice(1).every((t) => MOT_ANNULE.test(t) || MOT_FILLER.test(t));
}
function attenteExpiree(attente) {
  if (!attente || !attente.created_at) return false;
  const t = Date.parse(String(attente.created_at).replace(" ", "T") + "Z");
  return Number.isFinite(t) && Date.now() - t > EXPIRATION_ATTENTE_MS;
}

async function traiterMessage({ chatId, senderId, messageId, texte, cheminFichier }) {
  // Fichier joint : on route entre FICHE DE RELANCE (receptions, tableau
  // imprime "commerciaux") et FICHE D'APPEL (manuscrite Ben/Astride/Gloria).
  // Le routage se fait sur la legende + nom de fichier.
  if (cheminFichier) {
    const indice = `${texte || ""} ${path.basename(cheminFichier).replace(/^\d+-/, "")}`;
    const type = typeParIndice(indice);

    // --- SCAN-RETOUR d'une fiche d'appels branded (cases cochees) ---
    // On ne tente cette lecture que si l'indice le suggere (nom/legende), pour
    // ne pas payer une OCR specifique sur chaque document. Si ce n'est pas cette
    // fiche (est_fiche_rdv_appels=false), on retombe sur le routage normal.
    if (/fiche.*appel|rdv|rendez.?vous|non.?honor|suivi.?appel|lapin/i.test(indice)) {
      let fr = null;
      try { fr = await extraireFicheRdv(cheminFichier); } catch (e) { console.error(`[import] extraction fiche rdv : ${e.message}`); }
      if (fr && fr.est_fiche_rdv_appels && Array.isArray(fr.lignes) && fr.lignes.length) {
        enregistrerMessage({ message_id: messageId, chat_id: chatId, sender_id: senderId, role: "user", contenu: `${texte || ""}\n[fiche d'appels remplie jointe]`.trim(), fichier: cheminFichier });
        if (!peutExecuter(senderId, "creer_lead")) return repondre(chatId, "Tu n'as pas le droit d'importer dans Odoo. Contacte un responsable.");
        console.log(`[agent ${chatId.slice(-6)}] fiche d'appels remplie : ${fr.lignes.length} lignes`);
        let plan;
        try { plan = await construirePlanFicheRdv(fr, indice); }
        catch (e) {
          if (estErreurOdoo(e)) return repondre(chatId, `J'ai lu la fiche d'appels (${fr.lignes.length} lignes) et je l'ai gardee, mais Odoo est injoignable. Renvoie-la quand il sera revenu (gratuit, deja lue).`);
          throw e;
        }
        poserActionEnAttente(chatId, "import_fiche_rdv", plan, "Scan fiche d'appels");
        return repondre(chatId, resumePlanFicheRdv(plan));
      }
      // sinon : pas cette fiche -> routage normal ci-dessous.
    }

    // --- Fiche de relance (receptions relancees par un commercial) ---
    if (type === "reception") {
      let ex = null;
      try { ex = await extraireFicheReception(cheminFichier); } catch (e) { console.error(`[import] extraction reception : ${e.message}`); }
      if (ex && ex.type_fiche === "reception" && Array.isArray(ex.lignes) && ex.lignes.length) {
        enregistrerMessage({ message_id: messageId, chat_id: chatId, sender_id: senderId, role: "user", contenu: `${texte || ""}\n[fiche de relance jointe]`.trim(), fichier: cheminFichier });
        if (!peutExecuter(senderId, "creer_lead")) return repondre(chatId, "Tu n'as pas le droit d'importer dans Odoo. Contacte un responsable.");
        console.log(`[agent ${chatId.slice(-6)}] fiche de relance detectee : ${ex.lignes.length} lignes`);
        let plan;
        try { plan = await construirePlanRelance(ex, indice); }
        catch (e) {
          if (estErreurOdoo(e)) return repondre(chatId, `J'ai lu la fiche de relance (${ex.lignes.length} lignes) et je l'ai gardee, mais Odoo est injoignable. Renvoie-la quand il sera revenu (gratuit, deja lue).`);
          throw e;
        }
        poserActionEnAttente(chatId, "import_relance", plan, "Import fiche de relance");
        return repondre(chatId, resumePlanRelance(plan));
      }
      // Pas vraiment une reception -> on retombe sur la fiche d'appel.
    }

    // --- Fiche d'appel manuscrite (cas par defaut pour un document) ---
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

      // Routage sur le CONTENU (pas le nom de fichier) : une FEUILLE DE RELANCE
      // imprimee (pistes Odoo NR/NRP) part en import_relance, qui rapproche les
      // pistes existantes et pose les tags (concurrent, faux numero...). On
      // reutilise la MEME extraction (aucun 2e appel vision) en mappant les champs.
      if (extraction.est_feuille_relance_imprimee) {
        console.log(`[agent ${chatId.slice(-6)}] feuille de relance imprimee detectee : ${extraction.lignes.length} lignes`);
        const exRelance = {
          agent: extraction.agent, hash: extraction.hash,
          lignes: extraction.lignes.map((l, i) => ({
            nom: l.nom || "",
            telephone: l.telephone,
            commentaire: l.commentaire || "",
            resultat: l.code_resultat || "",          // code RESULTAT manuscrit du jour
            date_rdv: l.rdv_texte || "",
            date_session_brut: extraction.date_appels_brut || "",
            _page: l._page || null,
            _rang: l._rang || i + 1,
          })),
        };
        let planR;
        try {
          planR = await construirePlanRelance(exRelance, indice);
        } catch (e) {
          if (estErreurOdoo(e)) return repondre(chatId, `J'ai lu la feuille de relance (${extraction.lignes.length} lignes) et je l'ai gardee, mais Odoo est injoignable. Renvoie-la quand il sera revenu (gratuit, deja lue).`);
          throw e;
        }
        poserActionEnAttente(chatId, "import_relance", planR, "Import feuille de relance");
        return repondre(chatId, resumePlanRelance(planR));
      }

      console.log(`[agent ${chatId.slice(-6)}] fiche d'appel detectee : ${extraction.lignes.length} lignes`);
      let plan;
      try {
        plan = await construirePlan(extraction, indice);
      } catch (e) {
        if (estErreurOdoo(e)) {
          return repondre(chatId, `J'ai lu la fiche (${extraction.lignes.length} lignes) et je l'ai gardee, mais Odoo (CRM) est injoignable pour la preparer. Renvoie-la quand Odoo sera revenu — ce sera gratuit (deja lue).`);
        }
        throw e;
      }
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

  // Commande : forcer la relecture / reimport d'une fiche (purge du cache OCR).
  //   « relis la fiche gloria »      -> purge ocr_cache (re-OCR au prochain envoi)
  //   « reimporte la fiche gloria »  -> purge ocr_cache + memoire de synchro
  //      (autorise une RE-ECRITURE complete dans Odoo)
  if (texte) {
    // Verbes toleres : relis/relie/relire/recharge (re-OCR) ; reimporte/
    // reimporter/refais l'import (re-OCR + re-ecriture Odoo). Accepte « -moi »,
    // « la/ma/cette fiche », et « de/du/d' » devant le nom.
    const m = texte.match(/^\s*(r[eé]?li[se]?|r[eé]lire|recharge[rz]?|r[eé]-?importe?[rz]?|r[eé]-?lis)(?:[-\s]?moi)?\s+(?:l(?:a|e|es)?\s+|cette\s+|ma\s+|mon\s+)?(?:fiche|feuille|scan)s?\s+(?:de\s+|du\s+|des\s+|d['’]\s*)?(.+?)\s*[?!.]*$/i);
    if (m) {
      if (!peutExecuter(senderId, "creer_lead")) {
        return repondre(chatId, "Tu n'as pas le droit de gerer les imports. Contacte un responsable.");
      }
      const avecAppels = /import/i.test(m[1]); // reimporte -> reimport complet
      const saisie = m[2].trim();
      const trouve = resoudreFiches(saisie);
      if (!trouve.length) {
        return repondre(chatId, `Je ne trouve aucune fiche en cache qui corresponde à « ${saisie} ». Renvoie-la directement : si elle n'a jamais été lue, elle sera lue de zéro. (Ou dis « quelles fiches sont en cache ? ».)`);
      }
      if (trouve.length > 1) {
        const liste = trouve.slice(0, 8).map((f) => `• ${f.fichier} (${f.nb_lignes} lignes, ${f.jour})`).join("\n");
        return repondre(chatId, `Plusieurs fiches correspondent à « ${saisie} » :\n${liste}\nPrécise (ex : « ${avecAppels ? "reimporte" : "relis"} la fiche ${trouve[0].fichier.replace(/\.[a-z]+$/i, "")} »).`);
      }
      const r = purgerHashes(trouve.map((f) => f.hash), { avecAppels });
      journaliser(chatId, senderId, avecAppels ? "reimport_fiche" : "relecture_fiche", { saisie }, { fichier: trouve[0].fichier, ocr: r.ocrSupprimes, appels: r.appelsSupprimes });
      let msg = `C'est fait pour « ${trouve[0].fichier} » : cache OCR purgé.`;
      if (avecAppels) msg += ` Mémoire de synchro effacée (${r.appelsSupprimes} ligne(s)) : la fiche pourra être RÉ-IMPORTÉE entièrement.`;
      else msg += ` (Les lignes déjà importées restent protégées des doublons — dis « réimporte la fiche … » pour forcer une ré-écriture.)`;
      msg += `\n\nRenvoie-moi la fiche : elle sera relue de zéro avec le dernier modèle et les dernières règles.`;
      return repondre(chatId, msg);
    }
  }

  // Commande : SORTIR une fiche d'appels (lecture seule Odoo -> PDF branded).
  //   « sors la fiche des RDV du jour »     -> RDV programmes aujourd'hui (a confirmer)
  //   « sors la fiche des RDV non honores »  -> lapins septembre-octobre (relance)
  if (texte) {
    const demandeJour = /\b(sors|sortir|g[eé]n[eè]re[rz]?|donne|fais|envoie)\b[^]*\bfiche\b[^]*(rdv|rendez.?vous)?[^]*\b(du jour|d['’ ]?aujourd)/i.test(texte);
    const demandeLapins = /\b(sors|sortir|g[eé]n[eè]re[rz]?|donne|fais|envoie)\b[^]*\bfiche\b[^]*\b(lapin|non.?honor|pas.?honor|manqu)/i.test(texte);
    if (demandeJour || demandeLapins) {
      try {
        let lignes, nomFichier, titre, sousTitre, quoi;
        if (demandeJour) {
          const d = aujourdhuiCmr();
          lignes = await lignesRdvDuJour(d);
          nomFichier = `Fiche_RDV_du_jour_${d}.pdf`;
          titre = "FICHE D'APPELS H-1 — RDV du jour (appeler 1 heure avant)";
          sousTitre = `RDV du ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
          quoi = "RDV du jour";
        } else {
          const fin = aujourdhuiCmr();
          lignes = await lignesLapins("2026-09-01", fin);
          nomFichier = `Fiche_RDV_non_honores_${fin}.pdf`;
          titre = "FICHE D'APPELS — RDV non honorés (relance)";
          sousTitre = "Septembre & Octobre 2026";
          quoi = "RDV non honorés";
        }
        if (!lignes.length) return repondre(chatId, `Aucune ligne à sortir pour « ${quoi} » (rien trouvé dans Odoo).`);
        const chemin = await genererFicheAppel({ nomFichier, titre, sousTitre, lignes });
        journaliser(chatId, senderId, "fiche_rdv", { quoi }, { lignes: lignes.length, fichier: nomFichier });
        return repondre(chatId, `Fiche « ${quoi} » : ${lignes.length} ligne(s).`, chemin);
      } catch (e) {
        if (estErreurOdoo(e)) return repondre(chatId, "Odoo est injoignable, je ne peux pas sortir la fiche maintenant. Réessaie quand il sera revenu.");
        throw e;
      }
    }
  }

  // Fiche d'appel en attente d'en-tete : l'utilisateur fournit agent + date
  // (ex. « Ben 22/09/26 ») sans qu'on re-extraie la fiche.
  if (texte && !estConfirmation(texte) && !estAnnulation(texte)) {
    const enAttente = lireActionEnAttente(chatId);
    if (enAttente && enAttente.outil === "import_appels" && enteteInvalide(enAttente.parametres)) {
      const plan = enAttente.parametres;
      await completerEntete(plan, texte);
      poserActionEnAttente(chatId, "import_appels", plan, "Import fiche d'appel");
      return repondre(chatId, resumePlan(plan));
    }
  }

  // Corrections des lignes « a revoir » d'un import de relance en attente :
  // l'utilisateur donne les vraies valeurs (« #1 NR #2 RDV »). On tranche ces
  // lignes, on re-presente le recap mis a jour, et si un « oui » accompagne et
  // qu'il ne reste plus rien a revoir, on enregistre directement.
  if (texte && !estAnnulation(texte)) {
    const attente = lireActionEnAttente(chatId);
    if (attente && attente.outil === "import_relance" && !attenteExpiree(attente) && contientCorrections(texte)) {
      const plan = attente.parametres;
      const cr = appliquerCorrections(plan, texte);
      poserActionEnAttente(chatId, "import_relance", plan, attente.description || "Import fiche de relance");

      const bilan = [];
      if (cr.appliquees.length) bilan.push(`✅ ${cr.appliquees.length} ligne(s) corrigee(s) : ` + cr.appliquees.map((x) => `#${x.ref}→${x.categorie}`).join(", "));
      if (cr.inconnues.length) bilan.push(`⚠️ non compris : ` + cr.inconnues.map((x) => `#${x.ref}${x.saisie ? ` « ${x.saisie} »` : ""} (${x.raison})`).join(", "));

      const confirmeAussi = motsDe(texte).some((mot) => MOT_CONFIRME.test(mot));
      if (confirmeAussi && plan.a_revoir.length === 0) {
        prendreActionEnAttente(chatId);
        const r = stagerPlan(plan);
        journaliser(chatId, senderId, "import_relance", { agent: plan.agent, resume: plan.resume }, r);
        let msg = `${bilan.join("\n")}\n\nC'est garde en local : ${r.stagees} ligne(s) prete(s) a envoyer. Rien n'est encore dans Odoo.`;
        if (r.deja) msg += ` ${r.deja} etaient deja gardees (pas de doublon).`;
        msg += `\n\nQuand tu veux : « synchronise tout » pour tout envoyer, ou « qu'est-ce qui attend ? » pour voir le detail.`;
        return repondre(chatId, msg);
      }
      // Sinon on re-presente le recap a jour (il peut rester des lignes a revoir).
      return repondre(chatId, `${bilan.join("\n")}\n\n${resumePlanRelance(plan)}`);
    }
  }

  // Une ecriture attendait-elle une confirmation dans ce chat ?
  if (texte && (estConfirmation(texte) || estAnnulation(texte))) {
    const attente = prendreActionEnAttente(chatId);
    if (attente) {
      if (estAnnulation(texte)) {
        return repondre(chatId, "D'accord, j'annule. Rien n'a ete ecrit dans Odoo.");
      }
      // Garde-fou anti-« oui » tardif : une proposition trop vieille n'est plus
      // declenchee (on parlait probablement d'autre chose entre-temps).
      if (attenteExpiree(attente)) {
        return repondre(chatId, "Cette proposition datait de plus de 15 min : je l'ai laissee expirer par securite, rien n'a ete enregistre. Refais la demande (renvoyer la fiche est gratuit, elle est deja lue).");
      }

      // Import d'une fiche (appel manuscrite OU relance receptions) : on GARDE
      // d'abord en LOCAL, rien n'est ecrit dans Odoo. La synchro se declenche a
      // la demande (« synchronise tout / cecile / la fiche »), en tout ou partie.
      if (attente.outil === "import_appels" || attente.outil === "import_relance" || attente.outil === "import_fiche_rdv") {
        // Garde-fou en-tete : uniquement pour les fiches d'appel (agent/date
        // manuscrits). Les fiches de relance ont toujours une date par defaut.
        if (attente.outil === "import_appels" && enteteInvalide(attente.parametres)) {
          poserActionEnAttente(chatId, "import_appels", attente.parametres, "Import fiche d'appel");
          return repondre(chatId, "Il me faut l'agent et une date valide (ex : « Ben 22/09/26 ») avant d'enregistrer.");
        }
        const r = stagerPlan(attente.parametres); // local pur, pas d'Odoo -> pas d'echec reseau
        journaliser(chatId, senderId, attente.outil, { agent: attente.parametres.agent, resume: attente.parametres.resume }, r);
        let msg = `C'est garde en local : ${r.stagees} ligne(s) prete(s) a envoyer. Rien n'est encore dans Odoo.`;
        if (r.deja) msg += ` ${r.deja} etaient deja gardees (pas de doublon).`;
        msg += `\n\nQuand tu veux, dis-moi : « synchronise tout » pour tout envoyer, « synchronise <commercial> » (ou une date / une fiche) pour une partie, ou « qu'est-ce qui attend ? » pour voir le detail.`;
        return repondre(chatId, msg);
      }

      const outil = OUTILS[attente.outil];
      let resultat;
      try {
        resultat = await outil.executer(attente.parametres);
      } catch (e) {
        if (estErreurOdoo(e)) {
          poserActionEnAttente(chatId, attente.outil, attente.parametres, attente.description || "");
          return repondre(chatId, "Odoo (CRM) est injoignable, l'action n'a pas eu lieu. Reponds « oui » quand il sera revenu.");
        }
        throw e;
      }
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

      // Recherche interne : execution immediate, la boucle continue. Une
      // erreur (ex. Odoo down) ne casse PAS le tour : on la renvoie au modele
      // comme resultat d'outil pour qu'il reponde utilement (mode degrade).
      let retour;
      try {
        retour = await outil.executer(parametres);
      } catch (e) {
        retour = {
          texte: estErreurOdoo(e)
            ? "Odoo (CRM) est momentanement injoignable : impossible de lire cette donnee. Dis-le a l'utilisateur et propose ce que tu peux faire sans Odoo (discuter, lister les fiches deja scannees)."
            : `Erreur de l'outil ${nom} : ${e.message}`,
        };
      }
      journaliser(chatId, senderId, nom, parametres, { texte: retour.texte });
      if (retour.fichier) fichierAEnvoyer = retour.fichier;
      messages.push({ role: "tool", tool_call_id: appel.id, content: retour.texte });
    }
  }

  return repondre(chatId, "Je n'ai pas reussi a conclure cette demande, reformule ou decoupe-la.", fichierAEnvoyer);
}

// Routage du type de fiche d'apres la legende + le nom de fichier.
// "commerciaux/reception/relance/rapport/<commercial>" -> fiche de relance ;
// "ben/astride/gloria" -> fiche d'appel manuscrite ; sinon defaut fiche d'appel.
function typeParIndice(indice) {
  const t = (indice || "").toLowerCase();
  if (/commerc|r[eé]cept|relance|rapport|marie|sharone/.test(t)) return "reception";
  return "appel";
}

// Erreur due a Odoo injoignable (pour degrader proprement au lieu de casser).
function estErreurOdoo(e) {
  return /Odoo HTTP|Odoo:|ECONN|ETIMEDOUT|timeout|530|50[234]/i.test((e && e.message) || "");
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
