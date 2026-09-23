const { rechercherLire, creer } = require("./rpc");

// ---------------------------------------------------------------------------
// Requetes metier vers le CRM. Chaque fonction renvoie des lignes pretes a
// exporter : c'est du code deterministe, le modele n'ecrit jamais ces donnees.
// ---------------------------------------------------------------------------

function aujourdHui() {
  // La date locale Cameroun (UTC+1, sans heure d'ete).
  const maintenant = new Date(Date.now() + 3600 * 1000);
  return maintenant.toISOString().slice(0, 10);
}

// Personnes a appeler aujourd'hui : les activites planifiees sur des pistes,
// echues aujourd'hui ou en retard.
async function aAppelerAujourdhui({ agent = null, limite = 200 } = {}) {
  const domaine = [
    ["res_model", "=", "crm.lead"],
    ["date_deadline", "<=", aujourdHui()],
  ];
  if (agent) domaine.push(["user_id.name", "ilike", agent]);

  const activites = await rechercherLire(
    "mail.activity",
    domaine,
    ["res_id", "summary", "activity_type_id", "date_deadline", "user_id"],
    { limit: limite, order: "date_deadline asc" }
  );

  if (!activites.length) return [];

  const idsPistes = [...new Set(activites.map((a) => a.res_id))];
  const pistes = await rechercherLire(
    "crm.lead",
    [["id", "in", idsPistes]],
    ["id", "name", "contact_name", "phone", "mobile", "stage_id", "user_id"]
  );
  const parId = new Map(pistes.map((p) => [p.id, p]));

  return activites.map((a) => {
    const piste = parId.get(a.res_id) || {};
    return {
      piste_id: a.res_id,
      nom: piste.contact_name || piste.name || "",
      telephone: piste.phone || piste.mobile || "",
      etape: piste.stage_id ? piste.stage_id[1] : "",
      activite: a.summary || (a.activity_type_id ? a.activity_type_id[1] : ""),
      echeance: a.date_deadline,
      agent: a.user_id ? a.user_id[1] : "",
    };
  });
}

// RDV du calendrier sur une plage de dates (par defaut : aujourd'hui).
async function rendezVous({ debut = null, fin = null, agent = null, limite = 200 } = {}) {
  const jour = aujourdHui();
  const domaine = [
    ["start", ">=", `${debut || jour} 00:00:00`],
    ["start", "<=", `${fin || debut || jour} 23:59:59`],
  ];
  if (agent) domaine.push(["user_id.name", "ilike", agent]);

  const evenements = await rechercherLire(
    "calendar.event",
    domaine,
    ["id", "name", "start", "stop", "user_id", "opportunity_id"],
    { limit: limite, order: "start asc" }
  );

  return evenements.map((e) => ({
    rdv_id: e.id,
    objet: e.name,
    debut: e.start,
    fin: e.stop,
    agent: e.user_id ? e.user_id[1] : "",
    piste: e.opportunity_id ? e.opportunity_id[1] : "",
  }));
}

// Recherche d'une piste existante par telephone, pour eviter les doublons.
// Piege connu du call center : numeros a 8 chiffres = le 6 initial omis.
async function chercherParTelephone(telephone) {
  const brut = String(telephone).replace(/\D/g, "");
  const variantes = [...new Set([brut, brut.length === 8 ? `6${brut}` : null].filter(Boolean))];

  const clauses = [];
  for (const v of variantes) {
    clauses.push(["phone", "like", v], ["mobile", "like", v]);
  }
  const domaine = Array(clauses.length - 1).fill("|").concat(clauses);

  return rechercherLire(
    "crm.lead",
    domaine,
    ["id", "name", "contact_name", "phone", "mobile", "stage_id", "user_id", "type"],
    { limit: 10 }
  );
}

async function creerPiste({ nom, telephone, vehicule = "", note = "", agent = "" }) {
  const valeurs = {
    name: vehicule ? `${nom} - ${vehicule}` : nom,
    contact_name: nom,
    phone: telephone,
    type: "lead",
    description: note || undefined,
  };

  if (agent) {
    const utilisateurs = await rechercherLire("res.users", [["name", "ilike", agent]], ["id", "name"], { limit: 1 });
    if (utilisateurs.length) valeurs.user_id = utilisateurs[0].id;
  }

  const id = await creer("crm.lead", valeurs);
  return { id, valeurs };
}

async function creerRdv({ objet, debut, duree_heures = 1, piste_id = null, agent = "" }) {
  const dateDebut = new Date(debut);
  const dateFin = new Date(dateDebut.getTime() + duree_heures * 3600 * 1000);
  const format = (d) => d.toISOString().slice(0, 19).replace("T", " ");

  const valeurs = {
    name: objet,
    start: format(dateDebut),
    stop: format(dateFin),
  };
  if (piste_id) valeurs.opportunity_id = piste_id;

  if (agent) {
    const utilisateurs = await rechercherLire("res.users", [["name", "ilike", agent]], ["id", "name"], { limit: 1 });
    if (utilisateurs.length) valeurs.user_id = utilisateurs[0].id;
  }

  const id = await creer("calendar.event", valeurs);
  return { id, valeurs };
}

module.exports = { aAppelerAujourdhui, rendezVous, chercherParTelephone, creerPiste, creerRdv };
