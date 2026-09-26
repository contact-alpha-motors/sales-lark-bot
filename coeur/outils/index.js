const requetes = require("../../odoo/requetes");
const { interroger, compterCrm } = require("../../odoo/lecture");
const { listerFichesScannees, resumeEnAttente, hashesParFichier } = require("../../memoire/base");
const { synchroniser } = require("../../odoo/import_appels");
const { exporterXlsx } = require("../../documents/xlsx");
const { exporterPdf } = require("../../documents/pdf");
const { isoJour, enClair } = require("../dates");

function libelleFormat(format) {
  return format === "pdf" ? "PDF" : "Excel";
}

// ---------------------------------------------------------------------------
// Boite a outils de l'agent.
//
// Chaque outil expose :
//   schema     la declaration envoyee au modele (format OpenAI functions)
//   ecriture   true si l'outil modifie Odoo — il passera par la confirmation
//   executer   le code deterministe. Renvoie { texte, fichier? } ou, pour
//              une ecriture, la description a confirmer.
// ---------------------------------------------------------------------------

function horodatage() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16).replace(/[T:]/g, "-");
}

const OUTILS = {
  export_liste: {
    ecriture: false,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "export_liste",
        description:
          "Exporte une liste du CRM en fichier (Excel ou PDF) envoye dans la conversation. Listes disponibles : 'a_appeler' (personnes a appeler aujourd'hui, activites echues ou en retard) et 'rdv' (rendez-vous du calendrier sur une plage de dates). Pour 'rdv', fournis debut/fin en dates absolues AAAA-MM-JJ.",
        parameters: {
          type: "object",
          properties: {
            liste: { type: "string", enum: ["a_appeler", "rdv"] },
            format: { type: "string", enum: ["xlsx", "pdf"], description: "Format du fichier. 'pdf' si l'utilisateur demande un PDF, sinon 'xlsx' (defaut)." },
            agent: { type: "string", description: "Filtrer sur un commercial (nom ou partie du nom), optionnel" },
            debut: { type: "string", description: "Date de debut AAAA-MM-JJ (liste rdv). Convertis toi-meme 'demain' etc. en date." },
            fin: { type: "string", description: "Date de fin AAAA-MM-JJ (liste rdv). Egale a debut pour une seule journee." },
            periode_texte: { type: "string", description: "Reprends la formulation de l'utilisateur pour la periode, ex. 'demain', 'cette semaine'." },
            limite: { type: "number", description: "Nombre maximum de lignes, defaut 200" },
          },
          required: ["liste"],
        },
      },
    },
    decrire(p) {
      const libelle = p.liste === "rdv" ? "des rendez-vous" : "des personnes a appeler";
      let periode;
      if (p.liste === "rdv") {
        const d = p.debut || isoJour();
        const f = p.fin || d;
        periode = d === f ? `le ${enClair(d)}` : `du ${enClair(d)} au ${enClair(f)}`;
      } else {
        periode = `aujourd'hui (${enClair(isoJour())})`;
      }
      const terme = p.periode_texte ? `« ${p.periode_texte} » = ` : "";
      const filtre = p.agent ? `, commercial ${p.agent}` : "";
      return `Exporter en ${libelleFormat(p.format)} la liste ${libelle} : ${terme}${periode}${filtre}`;
    },
    async executer(p) {
      const lignes =
        p.liste === "rdv"
          ? await requetes.rendezVous(p)
          : await requetes.aAppelerAujourdhui(p);

      const libelle = p.liste === "rdv" ? "des rendez-vous" : "des personnes a appeler";
      const periode =
        p.liste === "rdv"
          ? (() => {
              const d = p.debut || isoJour();
              const f = p.fin || d;
              return d === f ? `le ${enClair(d)}` : `du ${enClair(d)} au ${enClair(f)}`;
            })()
          : `aujourd'hui (${enClair(isoJour())})`;

      if (!lignes.length) {
        return { texte: `Liste ${libelle} ${periode} : aucun resultat, aucun fichier genere.` };
      }

      const format = p.format === "pdf" ? "pdf" : "xlsx";
      const titre = `Liste ${libelle} ${periode}`;
      const nom = `${p.liste}-${horodatage()}.${format}`;
      const chemin =
        format === "pdf"
          ? await exporterPdf(nom, lignes, titre)
          : await exporterXlsx(nom, lignes, p.liste);

      return {
        texte: `Liste ${libelle} ${periode} : ${lignes.length} ligne(s), fichier ${libelleFormat(format)} joint.`,
        fichier: chemin,
      };
    },
  },

  interroger_crm: {
    ecriture: false,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "interroger_crm",
        description:
          "Lecture generalisee du CRM Odoo pour repondre a une question (renvoie les donnees dans la conversation, ne genere pas de fichier). " +
          "Choisis le modele et ecris un domaine Odoo (liste de conditions [champ, operateur, valeur]). " +
          "Modeles :\n" +
          "- x_reception : FICHE DE RECEPTION detaillee remplie par l'hotesse. UTILISE TOUJOURS CE MODELE pour 'prospects venus au showroom', 'clients recus', 'liste des visiteurs' avec leurs TELEPHONES et details : il contient le telephone (x_studio_tlphone) et les infos completes, meme quand le journal d'evenements ne les a pas. Champs : x_name (nom), x_studio_tlphone (telephone), x_studio_date_et_heure_de_reception (date/heure, parfois vide sur vieilles fiches - sinon filtre/borne dessus), x_studio_recu_par_1 (recu par, employe), x_studio_motif_de_discussion (RDV/Test Drive/Directement du stand/Autre), x_studio_rsultat_de_rception (Vente/Proforma/Promesse d'achat/Probleme de stock/Autre), x_studio_niveau_dintret, x_studio_qualit_prospect (Tiede/Froid/Chaud/Curieux), x_lieu_de_reception (Showroom/Bureau/Sortie/Autres), x_studio_action_suivante_prvue, x_commentaire, x_prospect (lien crm.lead). Valeurs deja en francais.\n" +
          "- dealership.event.log : JOURNAL d'interactions (appels, visites, test drives, messages, RDV) pour les COMPTAGES et statistiques, PAS pour lister les personnes recues. NE CONCLUS JAMAIS 'pas de telephone' depuis ce modele : son champ contact_phone est souvent vide alors que le prospect A un numero dans x_reception. Filtre 'event_type' par CODE : call, video_call, message, rdv, visit, test_drive. Filtre 'sub_type' par CODE : no_answer, call_back, wiil_come_back, already_came, client, not_online(PL), interested, not_interested, meeting_booked, video_meeting_booked, meeting_confirmed, scheduled(RDV honore), walk_in(visite spontanee), no_show(lapin), bad_number, completed. Champs : event_date, user_id, lead_id. BORNE TOUJOURS event_date (donnees bruitees : lignes futures, doublons).\n" +
          "- crm.lead : pistes/opportunites. Champs : name, contact_name, phone, mobile, stage_id, user_id, type, create_date.\n" +
          "- calendar.event : rendez-vous. Champs : start, stop, user_id, opportunity_id.\n" +
          "- mail.activity : activites PLANIFIEES (a faire, non encore faites). Champs : date_deadline, activity_type_id, user_id, res_model, res_id.\n" +
          "- mail.message : activites TERMINEES (cochees 'fait'). Filtre mail_activity_type_id != false et model='crm.lead', borne 'date'. C'est la seule trace des activites faites (mail.activity ne garde que le planifie). Rarement utilise par l'equipe.\n" +
          "- sale.order : devis et commandes (montant amount_total, etat 'state' : draft/sent/sale/cancel). Champs : partner_id, date_order, user_id.\n" +
          "- sale.order.line : lignes de devis (produit, quantite, prix).\n" +
          "- alpha.call.sheet : feuilles d'appel. alpha.lead.phase : phases du pipeline. dealership.daily.report : stats showroom. voip.call : appels VoIP. crm.team : equipes.\n" +
          "Les dates se filtrent en 'AAAA-MM-JJ HH:MM:SS'. Convertis toi-meme 'demain'/'aujourd'hui' en dates absolues a partir de la date du jour.",
        parameters: {
          type: "object",
          properties: {
            modele: {
              type: "string",
              enum: [
                "x_reception", "dealership.event.log", "crm.lead", "calendar.event", "mail.activity",
                "mail.message", "sale.order", "sale.order.line", "alpha.call.sheet", "alpha.lead.phase",
                "dealership.daily.report", "voip.call", "crm.team",
              ],
            },
            domaine: {
              type: "array",
              description: "Domaine Odoo, ex. [[\"event_type\",\"=\",\"visit\"],[\"event_date\",\">=\",\"2026-09-23 00:00:00\"],[\"event_date\",\"<=\",\"2026-09-23 23:59:59\"]]. Vide [] = tout (a eviter).",
              items: {},
            },
            mode: { type: "string", enum: ["liste", "compte"], description: "'compte' pour un nombre (ex. 'combien de visites'), 'liste' (defaut) pour les enregistrements." },
            limite: { type: "number", description: "Nombre max de lignes en mode liste (defaut 20, max 50)." },
          },
          required: ["modele"],
        },
      },
    },
    async executer(p) {
      if (p.mode === "compte") {
        const n = await compterCrm(p);
        return { texte: `Resultat du comptage : ${n}.` };
      }
      const lignes = await interroger(p);
      if (!lignes.length) return { texte: "Aucun resultat pour cette requete." };
      return { texte: `${lignes.length} resultat(s) :\n${JSON.stringify(lignes)}` };
    },
  },

  fiches_scannees: {
    ecriture: false,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "fiches_scannees",
        description:
          "Liste les fiches d'appel deja scannees et gardees en local (nom, nb de lignes, date). Fonctionne SANS Odoo — utilise-le pour dire ce qui a ete lu recemment, meme si le CRM est injoignable.",
        parameters: {
          type: "object",
          properties: { limite: { type: "number", description: "Nombre max de fiches, defaut 20" } },
        },
      },
    },
    async executer(p) {
      const l = listerFichesScannees(p.limite || 20);
      if (!l.length) return { texte: "Aucune fiche scannee en memoire locale." };
      return { texte: l.map((x) => `${x.jour} — ${x.fichier} (${x.nb_lignes} lignes)`).join("\n") };
    },
  },

  chercher_lead: {
    ecriture: false,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "chercher_lead",
        description: "Cherche une piste existante dans le CRM par numero de telephone, pour verifier les doublons avant creation.",
        parameters: {
          type: "object",
          properties: {
            telephone: { type: "string" },
          },
          required: ["telephone"],
        },
      },
    },
    async executer(p) {
      const pistes = await requetes.chercherParTelephone(p.telephone);
      if (!pistes.length) return { texte: "Aucune piste avec ce numero." };
      const lignes = pistes.map(
        (x) => `#${x.id} ${x.contact_name || x.name} — ${x.phone || x.mobile} — ${x.stage_id ? x.stage_id[1] : ""} — ${x.user_id ? x.user_id[1] : ""}`
      );
      return { texte: lignes.join("\n") };
    },
  },

  creer_lead: {
    ecriture: true,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "creer_lead",
        description:
          "Cree une nouvelle piste (lead) dans le CRM Odoo. Toujours verifier les doublons avec chercher_lead d'abord. L'utilisateur devra confirmer avant l'ecriture.",
        parameters: {
          type: "object",
          properties: {
            nom: { type: "string", description: "Nom du prospect" },
            telephone: { type: "string" },
            vehicule: { type: "string", description: "Vehicule d'interet, optionnel" },
            note: { type: "string", description: "Contexte libre, optionnel" },
            agent: { type: "string", description: "Commercial a qui attribuer, optionnel" },
          },
          required: ["nom", "telephone"],
        },
      },
    },
    decrire(p) {
      return `Creer la piste : ${p.nom}, tel ${p.telephone}${p.vehicule ? `, vehicule ${p.vehicule}` : ""}${p.agent ? `, attribuee a ${p.agent}` : ""}`;
    },
    async executer(p) {
      const { id } = await requetes.creerPiste(p);
      return { texte: `Piste #${id} creee dans Odoo : ${p.nom} (${p.telephone}).`, record_id: id };
    },
  },

  creer_rdv: {
    ecriture: true,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "creer_rdv",
        description:
          "Cree un rendez-vous dans le calendrier Odoo (ex. 'RDV Physique: Mr X'). L'utilisateur devra confirmer avant l'ecriture.",
        parameters: {
          type: "object",
          properties: {
            objet: { type: "string", description: "Objet du RDV, ex. 'RDV Physique: Mr Njuetse'" },
            debut: { type: "string", description: "Date et heure de debut, format AAAA-MM-JJTHH:MM (heure du Cameroun)" },
            duree_heures: { type: "number", description: "Duree en heures, defaut 1" },
            piste_id: { type: "number", description: "Id de la piste liee, optionnel" },
            agent: { type: "string", description: "Commercial concerne, optionnel" },
          },
          required: ["objet", "debut"],
        },
      },
    },
    decrire(p) {
      return `Creer le RDV : ${p.objet}, le ${p.debut}${p.agent ? `, pour ${p.agent}` : ""}${p.piste_id ? `, lie a la piste #${p.piste_id}` : ""}`;
    },
    async executer(p) {
      const { id } = await requetes.creerRdv(p);
      return { texte: `RDV #${id} cree dans Odoo : ${p.objet} le ${p.debut}.`, record_id: id };
    },
  },

  en_attente: {
    ecriture: false,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "en_attente",
        description:
          "Montre ce qui est GARDE EN LOCAL et pas encore envoye dans Odoo : total, repartition par commercial, par fiche et par date. " +
          "Utilise-le quand l'utilisateur demande « qu'est-ce qui attend ? », « combien en local ? », « qu'est-ce qui n'est pas encore sur Odoo ? ». Fonctionne SANS Odoo.",
        parameters: { type: "object", properties: {} },
      },
    },
    async executer() {
      const r = resumeEnAttente();
      if (!r.total && !r.erreurs) return { texte: "Rien en attente : tout est deja synchronise (ou rien n'a ete garde en local)." };
      const lignes = [`${r.total} ligne(s) en attente d'envoi dans Odoo${r.erreurs ? `, plus ${r.erreurs} en erreur (retentables)` : ""} :`];
      if (r.par_agent.length) lignes.push("- Par commercial : " + r.par_agent.map((x) => `${x.agent} (${x.n})`).join(", "));
      if (r.par_fiche.length) lignes.push("- Par fiche : " + r.par_fiche.map((x) => `${x.fichier} (${x.n})`).join(", "));
      if (r.par_date.length) lignes.push("- Par date : " + r.par_date.map((x) => `${x.date_appel} (${x.n})`).join(", "));
      lignes.push("", "Dis « synchronise tout » ou « synchronise <commercial / date / fiche> » pour envoyer dans Odoo.");
      return { texte: lignes.join("\n") };
    },
  },

  synchroniser_odoo: {
    ecriture: true,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "synchroniser_odoo",
        description:
          "Pousse vers Odoo les lignes gardees en local (issues des fiches scannees). C'est l'ETAPE d'ecriture : rien ne part dans Odoo avant. " +
          "Filtre selon la demande : par commercial (agent), par date (AAAA-MM-JJ), par fiche (bout du nom de fichier), par telephone, ou tout (tout=true). " +
          "« synchronise tout / envoie tout sur odoo » -> tout=true. « synchronise cecile » -> agent='cecile'. « envoie la fiche du 23 » -> date ou fiche selon le sens. Combine les filtres si besoin. " +
          "N'appelle ce outil QUE si l'utilisateur demande explicitement d'envoyer/synchroniser sur Odoo.",
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Commercial a synchroniser (nom ou partie), ex. 'cecile'" },
            date: { type: "string", description: "Date d'appel AAAA-MM-JJ a synchroniser" },
            fiche: { type: "string", description: "Bout du nom de la fiche/fichier a synchroniser" },
            telephone: { type: "string", description: "Un numero precis a synchroniser" },
            tout: { type: "boolean", description: "true = tout envoyer, sans filtre" },
          },
        },
      },
    },
    async executer(p) {
      const filtreBase = { agent: p.agent, date: p.date, telephone: p.telephone };
      const aucunFiltre = !p.tout && !p.agent && !p.date && !p.fiche && !p.telephone;
      if (aucunFiltre) {
        return { texte: "Precise quoi synchroniser : « tout », un commercial, une date ou une fiche. (Dis « qu'est-ce qui attend ? » pour voir le detail.)" };
      }

      const cumul = { total: 0, synced: 0, pistes_creees: 0, evenements: 0, activites: 0, deja_synced: 0, echecs: [], interrompu: false };
      const fusion = (r) => {
        for (const k of ["total", "synced", "pistes_creees", "evenements", "activites", "deja_synced"]) cumul[k] += r[k] || 0;
        cumul.echecs.push(...(r.echecs || []));
        if (r.interrompu) cumul.interrompu = true;
      };

      if (p.fiche) {
        const hashes = hashesParFichier(p.fiche);
        if (!hashes.length) return { texte: `Aucune fiche gardee dont le nom contient « ${p.fiche} ».` };
        for (const h of hashes) { if (cumul.interrompu) break; fusion(await synchroniser({ ...filtreBase, hash: h })); }
      } else {
        fusion(await synchroniser(filtreBase)); // filtres vides = tout ce qui attend
      }

      if (!cumul.total) return { texte: "Rien a synchroniser pour ce filtre (deja fait, ou aucune ligne ne correspond)." };
      let msg = `Synchro Odoo : ${cumul.synced}/${cumul.total} ligne(s) envoyee(s) — ${cumul.pistes_creees} nouvelle(s) piste(s), ${cumul.evenements} evenement(s), ${cumul.activites} RDV/relance(s) datee(s).`;
      if (cumul.deja_synced) msg += ` ${cumul.deja_synced} deja presente(s) dans Odoo (ignorees, pas de doublon).`;
      if (cumul.echecs.length) msg += ` ${cumul.echecs.length} en echec (gardees en local, retentables).`;
      if (cumul.interrompu) msg += ` ⚠️ Odoo est devenu injoignable : le reste reste garde en local, relance « synchronise » plus tard.`;
      return { texte: msg };
    },
  },
};

function schemas() {
  return Object.values(OUTILS).map((o) => o.schema);
}

module.exports = { OUTILS, schemas };
