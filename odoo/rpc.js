require("dotenv").config();

// ---------------------------------------------------------------------------
// Client JSON-RPC vers Odoo PRODUCTION (app.alphamotors-cameroun.com).
//
// ATTENTION : ne jamais pointer ce client sur odooee.alphamotors-cameroun.com.
// C'est une base fantome qui accepte les ecritures sans erreur apparente —
// verifie empiriquement le 2026-09-23.
// ---------------------------------------------------------------------------

const URL_ODOO = (process.env.ODOO_URL || "").replace(/\/$/, "");
const DB = process.env.ODOO_DB;
const UTILISATEUR = process.env.ODOO_USER;
const MOT_DE_PASSE = process.env.ODOO_PASSWORD;

let uidPromesse = null;

async function jsonrpc(service, methode, args) {
  const reponse = await fetch(`${URL_ODOO}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method: methode, args },
      id: Date.now(),
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!reponse.ok) {
    throw new Error(`Odoo HTTP ${reponse.status}`);
  }

  const donnees = await reponse.json();
  if (donnees.error) {
    const detail = donnees.error?.data?.message || donnees.error.message || "erreur inconnue";
    throw new Error(`Odoo: ${detail}`);
  }

  return donnees.result;
}

async function uid() {
  if (!uidPromesse) {
    uidPromesse = jsonrpc("common", "login", [DB, UTILISATEUR, MOT_DE_PASSE]).then((valeur) => {
      if (!valeur) {
        uidPromesse = null;
        throw new Error("Connexion Odoo refusee (identifiants)");
      }
      return valeur;
    });
  }
  return uidPromesse;
}

async function executer(modele, methode, args = [], kwargs = {}) {
  const identifiant = await uid();
  return jsonrpc("object", "execute_kw", [DB, identifiant, MOT_DE_PASSE, modele, methode, args, kwargs]);
}

function rechercherLire(modele, domaine, champs, options = {}) {
  return executer(modele, "search_read", [domaine], { fields: champs, ...options });
}

function creer(modele, valeurs) {
  return executer(modele, "create", [valeurs]);
}

function mettreAJour(modele, id, valeurs) {
  return executer(modele, "write", [[id], valeurs]);
}

module.exports = { executer, rechercherLire, creer, mettreAJour };
