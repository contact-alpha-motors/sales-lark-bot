#!/usr/bin/env node
// Affiche le cout modele cumule (jour / semaine / total) depuis journal_ia,
// et le detail par modele. Lecture seule, aucun appel paye.
//   node outils/cout.js
require("dotenv").config();
const { coutIa } = require("../memoire/base");
const Database = require("better-sqlite3");
const path = require("path");

const c = coutIa();
const f = (x) => `$${(x.c || 0).toFixed(6)}  (${x.n} appels, ${x.t} tokens)`;
console.log("Cout modele (OpenRouter) — d'apres la telemetrie locale :");
console.log("  aujourd'hui :", f(c.jour));
console.log("  7 jours     :", f(c.semaine));
console.log("  total       :", f(c.total));

const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "assistant.db"), { readonly: true });
const parModele = db.prepare(
  "SELECT modele, COUNT(*) n, COALESCE(SUM(cout),0) c, COALESCE(SUM(total_tokens),0) t FROM journal_ia GROUP BY modele ORDER BY c DESC"
).all();
console.log("\nPar modele (total) :");
for (const m of parModele) console.log(`  ${(m.modele || "?").padEnd(34)} ${m.n} appels  $${m.c.toFixed(6)}  ${m.t} tokens`);
