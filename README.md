# n8n lead pipeline (live demo)

**Try it:** https://n8n.kabiirlabs.com — fill in the form with an email you can check, then watch your lead move through the pipeline on the status page.

A self-hosted n8n workflow that takes a website enquiry and, in a few seconds:

1. validates it and runs a spam guard (honeypot, minimum fill time, link count, disposable-email block, per-email and per-IP rate limits, a daily cap);
2. answers the form straight away (HTTP 202) and keeps going in the background;
3. has **Google Gemini** score the lead 0-100 with a reason, next step and red flags, using a JSON schema, then **checks the answer against a strict contract** (types, ranges, allowed values, tier matches score). Anything off-contract is rejected and a deterministic rules score takes over;
4. creates or updates the contact in **HubSpot** (by email) and attaches a note with the score, reason and brief;
5. sends the lead a **reply email** and the team an **alert email** (through Resend);
6. records every step, so the visitor sees a **live status page** with the path their lead took.

Every outside call retries (3 tries, 2 s apart, with a timeout) and has its error output wired. If a step still fails, the lead keeps moving, the team gets an urgent alert carrying the whole lead, and the status page shows what failed. If even the alert cannot be sent, the execution is failed on purpose so n8n's Error Workflow alerts by its own route.

Fernbrook Studio, the business on the form, is fictional. The pipeline is real.

![Architecture](docs/architecture.svg)

## What is real and what is simulated

| Part | Real or simulated |
|---|---|
| n8n 2.45.7, self-hosted in Docker, four workflows | Real |
| Public gateway (form, status page, two API routes; everything else 404) | Real |
| Spam guard and rate limits | Real |
| Lead scoring by Google Gemini with a JSON schema | Real API call (free tier) |
| HubSpot contact and note | Real HubSpot account (free CRM, test data) |
| Reply email to the lead and team alert | Real emails sent through Resend |
| Live status page | Real: read from n8n data tables while the workflow runs |
| The business (Fernbrook Studio) | Simulated: fictional |
| "HubSpot is down" option on the form | Simulated outage: the CRM call goes to an internal n8n webhook that answers 503, so the retries, the urgent alert and the skipped note are real n8n behaviour |
| "AI returns broken JSON" option on the form | Simulated answer: a malformed reply is fed to the same contract check instead of calling Gemini |
| Tests | Unit tests use no network; the end-to-end tests run a real n8n against local stand-ins for Gemini, HubSpot and Resend |

## Try the failure paths

Open "Try the failure path" on the form:

- **HubSpot is down.** You see each failed attempt appear live (HTTP 503), the contact step fail after 3 tries, the note skipped, your reply still sent, and an urgent team alert that carries your full enquiry so nothing is lost.
- **The AI returns broken JSON.** The contract check rejects it, and the status page shows the rules fallback score and why the AI answer was refused.

## Security choices

- The tunnel points at the **gateway**, not at n8n. The gateway serves the two pages and forwards exactly `POST /api/lead` and `GET /api/status`. The n8n editor, REST API, other webhooks and test webhooks are not reachable from the internet (tested: they all answer 404 without touching n8n).
- The editor listens on `127.0.0.1:5680` only, behind an owner account with a generated password kept in a git-ignored file.
- API keys live in n8n's encrypted credential store (created by `scripts/setup.mjs` from a git-ignored `.env`); the exported workflow JSON carries placeholders only.
- The gateway forwards only the JSON body (no client cookies or headers), caps bodies at 16 KB, rate limits by client IP, hides unexpected n8n errors behind a plain 502, and sends a strict Content-Security-Policy.
- The lead's text is passed to the model as data, with an instruction to ignore instructions inside it; the score only drives wording and routing, never an action the lead controls. The model sees the email domain, not the person's name or address.
- The status page shows a masked email and never the message. The leads table stores a SHA-256 hash of the email for rate limiting, not the address.
- The simulated-outage workflow does not save execution data, because the request it receives carries the CRM credential header.
- Emails use idempotency keys per lead, so a retried send cannot send twice.

## Workflows (exported JSON in `workflows/`)

| File | Trigger | Nodes | What it does |
|---|---|---|---|
| `lead-intake.json` | `POST /webhook/lead-intake` | 42 | the pipeline above |
| `lead-status.json` | `GET /webhook/lead-status?id=` | 7 | builds the public timeline from the events table |
| `simulated-crm-outage.json` | `POST /webhook/sim-crm-outage` (internal) | 5 | answers 503 and logs each attempt |
| `error-alert.json` | Error Trigger | 3 | emails the team when an execution fails |
| `cleanup.json` | Schedule, daily 03:00 UTC | 3 | deletes pipeline records older than 14 days |

The JSON is generated from `src/workflows/pipeline.mjs`; Code-node logic lives in plain files in `src/code/` and is unit tested as is. `npm run check:workflows` fails if the committed JSON is stale.

## Tests

```bash
npm ci
npm test                                   # unit tests: validation, limits, AI contract, fallback, emails, timeline, gateway, workflow JSON
N8N_BIN=/path/to/n8n/bin/n8n npm run test:integration   # end to end on a real n8n 2.45.7 with local stand-ins
```

The end-to-end suite starts a throwaway n8n, creates the owner, data tables, credentials and workflows through n8n's API, and checks: the happy path (all 8 steps, request shapes, auth headers, idempotency keys, the note linked to the contact, one email each); that the status page never shows the full email or the message; spam, invalid and rate-limited submissions; an off-contract AI answer, Gemini down (3 tries then fallback) and Gemini recovering on the third try; the simulated CRM outage (live retries, note skipped, reply still sent, urgent alert); a failing note; a failing team alert (execution fails, Error Workflow alerts); and the daily cleanup deleting old records.

CI runs both suites on every push.

## Run your own

```bash
cp .env.example .env        # fill in the keys and addresses
docker compose up -d        # n8n on 127.0.0.1:5680 (editor), gateway on 127.0.0.1:5678 (public)
npm ci && npm run setup     # owner account, API key, data tables, credentials, workflows (safe to rerun)
```

Point a tunnel or reverse proxy at `127.0.0.1:5678` only. Without Docker, `N8N_BIN=/path/to/n8n/bin/n8n npm run local` runs the same two pieces as local processes.

HubSpot needs a private app token with `crm.objects.contacts.read` and `crm.objects.contacts.write`. Resend needs a verified sending domain.

## Limits

- One n8n instance in regular mode with SQLite; fine for a demo and small sites, not a high-volume queue setup.
- n8n's built-in retry waits a fixed time between tries (no exponential backoff).
- The gateway's per-IP limit is in memory and resets when it restarts; the per-email limits and daily cap are stored in n8n.
- Pipeline records (data tables) are deleted after 14 days and n8n execution history is pruned after 14 days. Demo contacts in the test HubSpot account are cleared by hand.

## License

MIT
