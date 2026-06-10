/**
 * Node ingestion CLI — the Banner → D1 write path.
 *
 * Ingestion runs from Node (not the Worker): the full-catalog sync and details
 * passes can run for many minutes, far past the Workers CPU limit. This CLI
 * builds a D1 client from `lib/db/client` (the REST or local-sqlite backend,
 * selected by D1_MODE) and drives the same `lib/ingest/*` functions the admin
 * routes used to call inline.
 *
 * Env (load `.env` first, e.g. `set -a; . ./.env; set +a`):
 *   D1_MODE=remote   + CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID / CLOUDFLARE_API_TOKEN
 *   D1_MODE=local    (default) writes the wrangler local D1 file
 *   SIS_BASE_URL     Banner host (defaults to the live UH host)
 *
 * Usage:
 *   yarn ingest refresh-terms
 *   yarn ingest sync [--term 202730] [--delayMs 250] [--subjectsPerSession N]
 *   yarn ingest sync-details --term 202730 [--delayMs 250] [--no-sections] ...
 *   yarn ingest refresh-seats --term 202730 [--subject ICS] [--crns a,b] [--max 100]
 */
import { getDb } from "@/lib/db/client";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm } from "@/lib/ingest/sync";
import { syncDetails } from "@/lib/ingest/details";
import { refreshSeats } from "@/lib/ingest/seatRefresh";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.startsWith("no-")) {
      flags[key.slice(3)] = false;
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      flags[key] = rest[++i];
    } else {
      flags[key] = true;
    }
  }
  return { cmd: cmd ?? "", flags };
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const db = getDb();
  const log = (msg: string) => console.log(msg);

  switch (cmd) {
    case "refresh-terms": {
      const terms = await refreshTerms(db);
      console.log(JSON.stringify({ ok: true, terms: terms.length }, null, 2));
      break;
    }

    case "sync": {
      const opts = {
        subjectDelayMs: num(flags.delayMs) ?? 250,
        ...(flags.subjectsPerSession
          ? { subjectsPerSession: num(flags.subjectsPerSession) }
          : {}),
        log,
      };
      const results = [];
      if (typeof flags.term === "string") {
        results.push(await syncTerm(db, flags.term, opts));
      } else {
        // Refresh the term list, then sync every currently-searchable term.
        await refreshTerms(db);
        const { results: terms } = await db
          .prepare("SELECT code FROM term WHERE is_view_only = 0")
          .all<{ code: string }>();
        for (const t of terms) results.push(await syncTerm(db, t.code, opts));
      }
      console.log(JSON.stringify({ ok: true, results }, null, 2));
      break;
    }

    case "sync-details": {
      if (typeof flags.term !== "string") throw new Error("--term is required");
      const result = await syncDetails(db, flags.term, {
        filters: flags.filters !== false,
        catalog: flags.catalog !== false,
        sections: flags.sections !== false,
        instructors: flags.instructors !== false,
        text: flags.text !== false,
        courseDelayMs: num(flags.delayMs) ?? 250,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    case "refresh-seats": {
      if (typeof flags.term !== "string") throw new Error("--term is required");
      const result = await refreshSeats(db, flags.term, {
        subject: typeof flags.subject === "string" ? flags.subject : undefined,
        crns:
          typeof flags.crns === "string"
            ? flags.crns.split(",").filter(Boolean)
            : undefined,
        maxSections: num(flags.max),
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }

    default:
      console.error(
        "Usage: yarn ingest <refresh-terms|sync|sync-details|refresh-seats> [flags]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
