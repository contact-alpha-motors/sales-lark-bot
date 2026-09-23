const { rechercherLire, compter } = require("./rpc");

// ---------------------------------------------------------------------------
// Lecture generalisee du CRM.
//
// Un seul outil peut interroger n'importe lequel des modeles de la liste
// blanche ci-dessous, avec un domaine Odoo libre. On ne cable plus une
// fonction par question : c'est ce qui manquait quand le bot refusait les
// visites showroom.
//
// La liste blanche borne la surface lisible ; pour chaque modele on definit
// les champs renvoyes par defaut et les libelles francais des codes de
// selection (le filtre se fait sur le CODE, l'affichage sur le LIBELLE).
// ---------------------------------------------------------------------------

const EVENT_TYPE = {
  call: "Appel", video_call: "Appel Video", message: "Message (WA/SMS)",
  rdv: "Rendez-vous", visit: "Visite Showroom", test_drive: "Test Drive",
};

const SUB_TYPE = {
  no_answer: "Ne repond pas", call_back: "Rappel prevu", wiil_come_back: "Nous revient",
  already_came: "Deja Passe", client: "Deja Achete", not_online: "PL",
  cant_call_now: "Non Disponible", interested: "Interesse", not_interested: "Pas interesse",
  video_meeting_booked: "RDV Video", meeting_booked: "RDV Physique Fixe",
  meeting_confirmed: "RDV Confirme", scheduled: "RDV Honore", walk_in: "Visite Spontanee",
  no_show: "Lapin (No-Show)", completed: "Termine", bad_number: "Faux numero",
};

const MODELES = {
  "crm.lead": {
    tri: "create_date desc",
    champs: ["id", "name", "contact_name", "phone", "mobile", "stage_id", "user_id", "type", "create_date"],
  },
  "dealership.event.log": {
    tri: "event_date desc",
    champs: ["id", "event_type", "sub_type", "event_date", "x_studio_nom", "contact_phone", "user_id", "lead_id", "callback_date", "notes"],
    libelles: { event_type: EVENT_TYPE, sub_type: SUB_TYPE },
  },
  "calendar.event": {
    tri: "start asc",
    champs: ["id", "name", "start", "stop", "user_id", "opportunity_id"],
  },
  "mail.activity": {
    tri: "date_deadline asc",
    champs: ["id", "res_model", "res_id", "activity_type_id", "summary", "date_deadline", "user_id"],
  },
  "sale.order": {
    tri: "date_order desc",
    champs: ["id", "name", "partner_id", "amount_total", "state", "date_order", "user_id"],
  },
  "sale.order.line": {
    tri: "id desc",
    champs: ["id", "order_id", "product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"],
  },
  "alpha.call.sheet": {
    tri: "create_date desc",
    champs: ["id", "display_name", "state", "create_date"],
  },
  "alpha.lead.phase": {
    tri: "id asc",
    champs: ["id", "display_name"],
  },
  "dealership.daily.report": {
    tri: "id desc",
    champs: ["id", "display_name"],
  },
  "voip.call": {
    tri: "id desc",
    champs: ["id", "phone_number", "state", "user_id", "partner_id"],
  },
  "crm.team": {
    tri: "id asc",
    champs: ["id", "name"],
  },
};

const MODELES_AUTORISES = Object.keys(MODELES);

function traduire(conf, ligne) {
  if (!conf.libelles) return ligne;
  const sortie = { ...ligne };
  for (const [champ, table] of Object.entries(conf.libelles)) {
    if (sortie[champ] && table[sortie[champ]]) sortie[champ] = table[sortie[champ]];
  }
  return sortie;
}

async function interroger({ modele, domaine = [], champs, tri, limite = 20 }) {
  const conf = MODELES[modele];
  if (!conf) {
    throw new Error(`Modele non autorise : ${modele}. Autorises : ${MODELES_AUTORISES.join(", ")}`);
  }
  const f = Array.isArray(champs) && champs.length ? champs : conf.champs;
  const lim = Math.min(Math.max(1, limite || 20), 50);
  const lignes = await rechercherLire(modele, domaine, f, { limit: lim, order: tri || conf.tri });
  return lignes.map((l) => traduire(conf, l));
}

async function compterCrm({ modele, domaine = [] }) {
  if (!MODELES[modele]) {
    throw new Error(`Modele non autorise : ${modele}. Autorises : ${MODELES_AUTORISES.join(", ")}`);
  }
  return compter(modele, domaine);
}

module.exports = { interroger, compterCrm, MODELES_AUTORISES };
