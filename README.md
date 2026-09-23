# Sales Assistant Bot — Alpha Motors

Assistant commercial sur Lark : on lui parle, il agit sur le CRM Odoo de
production et renvoie des fichiers.

Ce qu'il sait faire aujourd'hui :

- **Converser** (Gemini Flash-Lite via OpenRouter ; Flash seulement pour la
  lecture de documents), avec memoire : fenetre
  glissante des 20 derniers messages + resume quotidien de chaque
  conversation (cron 21h30), donc cout constant par tour.
- **Exporter des listes** en Excel : personnes a appeler aujourd'hui,
  RDV du calendrier — filtrables par agent, dates, limite.
- **Creer des leads et des RDV** dans Odoo, toujours apres verification des
  doublons (recherche par telephone) et confirmation "oui" de l'utilisateur.
- **Lire les documents joints** (photo, scan, PDF) : le contenu transcrit
  entre dans la conversation et peut alimenter une creation de lead.

## Architecture

```
index.js               demarre un adaptateur Lark par espace de travail + le cron des resumes
lark/                  adaptateur (WSClient, telechargement/envoi de fichiers)
coeur/agent.js         la boucle : contexte -> modele -> outils -> reponse
coeur/contexte.js      consignes + resumes + fenetre glissante
coeur/resumeur.js      compresseur de contexte quotidien
coeur/outils/          export_liste, chercher_lead, creer_lead, creer_rdv
coeur/droits.js        seuls les open_ids de LARK_ECRIVAINS peuvent ecrire dans Odoo
odoo/                  client JSON-RPC production + requetes metier
memoire/base.js        SQLite : messages, resumes, actions en attente, journal
documents/xlsx.js      rendu Excel
ia.js                  passerelle OpenRouter (CONVERSATION / RESUME / VISION)
```

Le coeur ne connait pas Lark : brancher WhatsApp (Evolution API) plus tard
se fera en ajoutant un second adaptateur, sans toucher au reste.

## Garde-fous

- Les donnees des listes viennent d'Odoo par du code, jamais du modele.
- Toute ecriture Odoo est gelee en "action en attente" jusqu'au "oui".
- Chaque action executee est tracee dans la table `journal`.
- Ecrire = vise `app.alphamotors-cameroun.com` uniquement. `odooee.` est une
  base fantome qui accepte tout sans erreur : ne jamais l'utiliser.

## Demarrer

```
cp .env.example .env   # completer les secrets
npm install
npm start
```

Ou via Docker : `docker compose up -d --build`.

## Reste a faire

- Fiches generees (fiche d'appel / fiche de lead) en DOCX/PDF — gabarits a
  definir avec la direction commerciale, puis conversion LibreOffice.
- Cartes interactives Lark (boutons Confirmer/Annuler) a la place du "oui".
- Liste "relances proformas" : aligner la definition sur celle des workflows
  n8n existants avant de l'exposer.
- Adaptateur WhatsApp (Evolution API).
