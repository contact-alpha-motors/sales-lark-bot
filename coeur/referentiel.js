// ---------------------------------------------------------------------------
// Referentiel des statuts d'appel du Call Center Alpha Motors.
//
// Traduit le code manuscrit d'une fiche d'appel en sous-type dealership.event.log.
// Regles de la direction (voir memoire project_call_center_referentiel) :
//   - NR = "nous revient" = prospect JOINT (pas un sans-reponse).
//   - BL = "budget limite" (contact etabli), presque toujours suivi d'un montant.
//   - Statut mixte (ex. "NRP - PI") : toute preuve de contact prime sur l'absence
//     de reponse -> on prend le meilleur code par priorite.
//   - PP et OUI : sens non tranche -> AMBIGU, on n'importe pas (mode sur).
//   - DP (partenariat) / DE (emploi) : hors commercial -> routage.
// ---------------------------------------------------------------------------

// Variantes de saisie -> code canonique.
const VARIANTES = {
  NRP: ["NRP", "HRP", "NMP", "NIR", "NKP", "NBP"],
  NR: ["NR", "HR", "MR", "MRP"],
  RDV: ["RDV", "PDV", "RDY"],
  PL: ["PL", "PEL"],
  PI: ["PI"],
  BL: ["BL"],
  PP: ["PP"],
  OUI: ["OUI"],
  DP: ["DP"],
  DE: ["DE"],
};

const VERS_CANON = {};
for (const [canon, liste] of Object.entries(VARIANTES)) {
  for (const v of liste) VERS_CANON[v] = canon;
}

// Code canonique -> sous-type dealership.event.log.
const SOUS_TYPE = {
  NRP: "no_answer",
  PL: "not_online",
  PI: "not_interested",
  NR: "wiil_come_back",
  RDV: "meeting_booked",
  BL: "interested",
};

// Plus le code est haut, plus il prime (une preuve de contact l'emporte sur un
// sans-reponse). PP/OUI/DP/DE ne sont pas ici : traites a part.
const PRIORITE = ["RDV", "NR", "PI", "BL", "PL", "NRP"];

const AMBIGUS = new Set(["PP", "OUI"]);
const ROUTAGE = new Set(["DP", "DE"]);

// Numeros a 8 chiffres = 6XXXXXXXX saisis sans le 6 initial. On re-prefixe.
function normaliserTelephone(brut) {
  const d = String(brut || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 8) return `6${d}`;
  return d;
}

function telephoneValide(tel) {
  return !!tel && tel.length >= 8;
}

// Analyse le code manuscrit (et le commentaire pour "video" / montant BL).
// Renvoie { statut: 'ok'|'ambigu'|'routage', sous_type, event_type, note, codes }.
function analyserResultat(codeResultat, commentaire = "") {
  const texte = `${codeResultat || ""} ${commentaire || ""}`.toUpperCase();
  const tokens = (codeResultat || "").toUpperCase().match(/[A-Z]+/g) || [];
  const canons = new Set(tokens.map((t) => VERS_CANON[t]).filter(Boolean));

  // Meilleur code commercial par priorite.
  const meilleur = PRIORITE.find((c) => canons.has(c));

  if (meilleur) {
    let sous_type = SOUS_TYPE[meilleur];
    let event_type = "call";
    if (meilleur === "RDV" && /VID[EÉ]O/.test(texte)) {
      sous_type = "video_meeting_booked";
      event_type = "video_call";
    }
    let note = "";
    if (meilleur === "BL") {
      const montant = (commentaire || "").match(/\d+(?:[.,]\d+)?\s?(?:m|millions?|fcfa)?/i);
      note = montant ? `Budget limite (${montant[0].trim()})` : "Budget limite";
    }
    return { statut: "ok", sous_type, event_type, canon: meilleur, note };
  }

  if ([...canons].some((c) => ROUTAGE.has(c))) {
    const c = [...canons].find((x) => ROUTAGE.has(x));
    return { statut: "routage", canon: c, note: c === "DP" ? "Demande de partenariat" : "Demande d'emploi" };
  }

  // Formes ECRITES (pas un code) qui signifient "pas joignable" = PL.
  // Couvre injoignable + ses variantes OCR (imjoign...), telephone eteint,
  // messagerie, appel renvoye.
  if (/INJOIG|IMJOIG|JOIGN|[EÉ]TEINT|MESSAGERIE|APPEL RENVOY/.test(texte)) {
    return { statut: "ok", sous_type: "not_online", event_type: "call", canon: "PL", note: "" };
  }

  // PP, OUI ou code inconnu : on ne tranche pas.
  return { statut: "ambigu", canon: [...canons][0] || (codeResultat || "").trim(), note: "" };
}

// --- Detection agent / date depuis un indice libre (nom de fichier, legende) ---
// Il n'y a que trois agents ; leurs fiches sont souvent sans en-tete mais
// nommees "Fiche Ben 22 septembre.pdf".
function detecterAgent(texte) {
  const t = (texte || "").toLowerCase();
  if (/astri/.test(t)) return "Astride";
  if (/gloria|ngakeu/.test(t)) return "Gloria";
  if (/\bben\b|ben\s*azir/.test(t)) return "Ben";
  return null;
}

const MOIS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

function sansAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// "22 septembre 2026", "22 septembre", "22/09/26", "22/09/2026" -> AAAA-MM-JJ.
function detecterDate(texte, anneeDefaut = 2026) {
  const t = sansAccents((texte || "").toLowerCase());
  const ymd = (y, m, j) =>
    m >= 1 && m <= 12 && j >= 1 && j <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}` : null;

  let m = t.match(/(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s*(\d{4})?/);
  if (m) return ymd(m[3] ? Number(m[3]) : anneeDefaut, MOIS_FR[m[2]], Number(m[1]));

  m = t.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (m) {
    let annee = anneeDefaut;
    if (m[3]) annee = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return ymd(annee, Number(m[2]), Number(m[1]));
  }
  return null;
}

module.exports = { normaliserTelephone, telephoneValide, analyserResultat, detecterAgent, detecterDate };
