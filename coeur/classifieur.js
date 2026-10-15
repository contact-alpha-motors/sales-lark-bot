// ---------------------------------------------------------------------------
// Classement type-safe des resultats d'appel (API Decisions, modele jev).
//
// L'OCR transcrit le resultat manuscrit BRUT (ex "Injoignable", "NRP", "DI").
// Ce module le range dans une categorie imposee, SEPAREMENT de la lecture.
// Un seul appel classe toutes les lignes d'une fiche (batch), avec une
// CONFIANCE calibree.
//
// REGLE DE SURETE (direction : "ce bot n'a pas droit a l'erreur") :
//   - confiance >= SEUIL  -> on ecrit la categorie automatiquement.
//   - confiance <  SEUIL  -> "a revoir" : on N'ECRIT PAS d'office, mais on
//     PROPOSE le choix de plus haute probabilite comme suggestion a l'humain.
// Banc d'essai (fiche Gloria, 90 lignes) : avec SEUIL 0.8, 83/90 ecrites
// automatiquement, 0 erreur silencieuse ; les 7 incertaines (dont l'unique
// vraie erreur) partent en "a revoir". jev brut 89/90 (99%).
//
// Convention direction : "injoignable" = Ne repond pas (PAS "pas en ligne").
// ---------------------------------------------------------------------------

const { appelerDecisions } = require("../ia");

const SEUIL = Number(process.env.IA_CLASSIF_SEUIL || 0.8);

// Categories imposees -> critere lu par jev. "injoignable" est RANGE dans
// "Ne repond pas" (convention), et EXCLU de "Pas en ligne".
const CRITERES = {
  "Ne répond pas": "NRP, ou 'injoignable' (et variantes mal ecrites: ingoignable, imjoignable, injoign) : appel non abouti, personne ne decroche",
  "Pas en ligne": "PL/PEL : numero eteint, messagerie, appel renvoye, pas en service — PAS 'injoignable'",
  "Non disponible": "ND : contact etabli mais la personne est indisponible / 'indisponible'",
  "Rappel prévu": "un rappel est explicitement programme a une date",
  "Nous revient": "NR : le client doit nous revenir / nous recontacter plus tard",
  "Intéressé": "BL (budget limite) ou client clairement interesse",
  "Pas intéressé": "PI/DI/PT : pas interesse, ne plus rappeler",
  "RDV": "rendez-vous physique pris",
  "RDV vidéo": "rendez-vous en visio / video",
  "Déjà passé": "le client est deja venu au showroom",
  "Déjà acheté": "le client a deja achete un vehicule",
  "Faux numéro": "numero faux / incorrect / inexistant",
  "Hors commercial": "DP = demande de partenariat, ou DE = demande d'emploi",
  "Illisible": "vraiment illisible / indechiffrable",
};

const CONTEXTE =
  "Feuille de relance telephonique Alpha Motors (concession auto). Codes manuscrits usuels : " +
  "PI=pas interesse, NR=nous revient, NRP=ne repond pas, RDV, PL=pas en ligne, BL=budget limite (interesse), " +
  "DP=demande de partenariat, DE=demande d'emploi, ND=non disponible. 'Injoignable'=ne repond pas. " +
  "Le texte peut etre mal ecrit ou mal lu par l'OCR.";

// Categorie jev -> verdict compatible avec analyserResultat :
// { statut:'ok'|'routage', sous_type, event_type, canon, note }.
const VERS_VERDICT = {
  "Ne répond pas": { statut: "ok", sous_type: "no_answer", event_type: "call", canon: "NRP" },
  "Pas en ligne": { statut: "ok", sous_type: "not_online", event_type: "call", canon: "PL" },
  "Non disponible": { statut: "ok", sous_type: "cant_call_now", event_type: "call", canon: "ND" },
  "Rappel prévu": { statut: "ok", sous_type: "call_back", event_type: "call", canon: "RAPPEL" },
  "Nous revient": { statut: "ok", sous_type: "wiil_come_back", event_type: "call", canon: "NR" },
  "Intéressé": { statut: "ok", sous_type: "interested", event_type: "call", canon: "BL" },
  "Pas intéressé": { statut: "ok", sous_type: "not_interested", event_type: "call", canon: "PI" },
  "RDV": { statut: "ok", sous_type: "meeting_booked", event_type: "call", canon: "RDV" },
  "RDV vidéo": { statut: "ok", sous_type: "video_meeting_booked", event_type: "video_call", canon: "RDV" },
  "Déjà passé": { statut: "ok", sous_type: "wiil_come_back", event_type: "call", canon: "NR", note: "Déjà passé au showroom" },
  "Déjà acheté": { statut: "ok", sous_type: "client", event_type: "call", canon: "DA", note: "Déjà acheté" },
  "Faux numéro": { statut: "ok", sous_type: "bad_number", event_type: "call", canon: "FAUX" },
  "Hors commercial": { statut: "routage", canon: "DP/DE", note: "Hors commercial (partenariat/emploi)" },
  "Illisible": { statut: "ambigu", canon: "illisible", note: "" },
};

// BL (interesse) : si un montant figure dans le commentaire, on l'annote.
function noteInteresse(commentaire) {
  const m = (commentaire || "").match(/\d+(?:[.,]\d+)?\s?(?:m|millions?|fcfa)?/i);
  return m ? `Budget limite (${m[0].trim()})` : "Budget limite";
}

// Transforme une reponse jev (choice + confidence) en verdict.
function verdictDepuisReponse(choice, confidence, commentaire) {
  const base = VERS_VERDICT[choice];
  // Choix hors mapping (ne devrait pas arriver, enum ferme) -> a revoir.
  if (!base) {
    return { statut: "ambigu", canon: choice || "?", note: "", confiance: confidence, a_revoir: true,
      propose: choice ? { categorie: choice, confiance: confidence } : null };
  }
  const v = { ...base, confiance: confidence };
  if (v.sous_type === "interested" && !v.note) v.note = noteInteresse(commentaire);

  // Sous le seuil : "a revoir". On N'IMPOSE PAS la categorie, mais on PROPOSE
  // le choix de plus haute probabilite (= `choice`) comme suggestion humaine.
  if (confidence == null || confidence < SEUIL) {
    return {
      statut: "ambigu",
      canon: v.canon,
      note: v.note || "",
      confiance: confidence,
      a_revoir: true,
      // Suggestion a confirmer (categorie + sous-type correspondant).
      propose: { categorie: choice, sous_type: base.sous_type || null, event_type: base.event_type || null, confiance: confidence },
    };
  }
  // "Hors commercial" / "Illisible" gardent leur statut (routage/ambigu) meme
  // au-dessus du seuil (pas de sous-type d'evenement a ecrire).
  v.a_revoir = v.statut !== "ok";
  return v;
}

// SAV = demande service apres-vente : pas dans l'enum jev, regle deterministe.
function overrideSAV(brut) {
  if (/\bSAV\b/i.test(brut || "")) {
    return { statut: "ok", sous_type: "not_interested", event_type: "call", canon: "SAV", note: "Demande SAV", tag: "SAV", confiance: 1, a_revoir: false };
  }
  return null;
}

// Classe une liste d'items { resultat_brut, commentaire }. Renvoie un tableau
// de verdicts ALIGNE sur l'entree. Jette si jev est indisponible (l'appelant
// replie alors sur la regle locale analyserResultat, ligne par ligne).
async function classifierResultats(items) {
  const liste = items || [];
  if (!liste.length) return [];

  // Overrides deterministes (SAV) : pas la peine d'interroger jev dessus.
  const verdicts = new Array(liste.length).fill(null);
  const questions = {};
  liste.forEach((it, i) => {
    const sav = overrideSAV(it.resultat_brut);
    if (sav) { verdicts[i] = sav; return; }
    questions["L" + i] = {
      type: "choice",
      instructions:
        `Resultat d'appel manuscrit lu : "${it.resultat_brut || ""}"` +
        (it.commentaire ? ` ; commentaire : "${it.commentaire}"` : "") +
        ". Choisis la categorie la plus proche.",
      criteria: CRITERES,
    };
  });

  // Tout etait un override (rare) -> pas d'appel jev.
  if (!Object.keys(questions).length) return verdicts;

  const answers = await appelerDecisions(questions, { contexte: CONTEXTE });

  liste.forEach((it, i) => {
    if (verdicts[i]) return; // deja resolu (SAV)
    const a = answers["L" + i];
    if (!a || !a.choice) {
      // jev n'a pas repondu pour cette ligne -> a revoir, sans suggestion.
      verdicts[i] = { statut: "ambigu", canon: (it.resultat_brut || "").trim(), note: "", confiance: null, a_revoir: true, propose: null };
      return;
    }
    verdicts[i] = verdictDepuisReponse(a.choice, a.confidence, it.commentaire);
  });

  return verdicts;
}

// Verdict ferme (sous_type/event_type) d'une categorie imposee, ou d'un code
// manuscrit usuel. Sert aux CORRECTIONS humaines ("#1 NR" / "#1 Nous revient").
// Retourne null si la saisie ne correspond a aucune categorie connue.
function sansAcc(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
const CODE_VERS_CATEGORIE = {
  NR: "Nous revient", NRP: "Ne répond pas", PI: "Pas intéressé", RDV: "RDV",
  PL: "Pas en ligne", BL: "Intéressé", ND: "Non disponible", DP: "Hors commercial",
  DE: "Hors commercial", DA: "Déjà acheté", SAV: "Pas intéressé",
};
function verdictDeSaisie(saisie) {
  const s = sansAcc(saisie);
  if (!s) return null;
  // 1) Code manuscrit (NR, NRP, PI, RDV, PL, BL, ND, DP, DE...).
  const code = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (CODE_VERS_CATEGORIE[code]) {
    const cat = CODE_VERS_CATEGORIE[code];
    return { ...VERS_VERDICT[cat], categorie: cat, canon: code };
  }
  // 2) Libelle de categorie ("Nous revient", "pas interesse"...).
  const cat = Object.keys(VERS_VERDICT).find((k) => sansAcc(k) === s);
  if (cat) return { ...VERS_VERDICT[cat], categorie: cat };
  return null;
}

module.exports = { classifierResultats, verdictDeSaisie, SEUIL, CRITERES, CONTEXTE };
