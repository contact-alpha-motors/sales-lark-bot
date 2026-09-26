// ---------------------------------------------------------------------------
// Droits par utilisateur Lark.
//
// Tout le monde peut consulter et exporter. Seuls les open_ids listes dans
// LARK_ECRIVAINS peuvent declencher une ecriture dans Odoo. Liste vide =
// tout le monde ecrit (mode developpement uniquement — a ne pas laisser
// ainsi en production).
// ---------------------------------------------------------------------------

const OUTILS_ECRITURE = new Set(["creer_lead", "creer_rdv", "synchroniser_odoo"]);

function ecrivains() {
  return (process.env.LARK_ECRIVAINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function peutExecuter(senderId, outil) {
  if (!OUTILS_ECRITURE.has(outil)) return true;

  const liste = ecrivains();
  if (!liste.length) return true;

  return liste.includes(senderId);
}

module.exports = { peutExecuter, OUTILS_ECRITURE };
