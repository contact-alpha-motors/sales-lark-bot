// ---------------------------------------------------------------------------
// Dates en heure du Cameroun (UTC+1, sans heure d'ete) et mise en clair en
// francais. Le modele raisonne mal sur "demain" s'il ne connait pas la date
// du jour ; et la phase de confirmation doit toujours enoncer la date en
// toutes lettres, pas seulement le mot relatif de l'utilisateur.
// ---------------------------------------------------------------------------

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = [
  "janvier", "fevrier", "mars", "avril", "mai", "juin",
  "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
];

function maintenantCmr() {
  return new Date(Date.now() + 3600 * 1000);
}

function isoJour(date = maintenantCmr()) {
  return date.toISOString().slice(0, 10);
}

// "2026-09-24" -> "mercredi 24 septembre 2026". On ancre a midi UTC pour que
// le jour de la semaine ne bascule pas selon le fuseau.
function enClair(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${JOURS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

module.exports = { maintenantCmr, isoJour, enClair };
