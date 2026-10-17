# SGP integration

TR69 Controle can read subscriber contract and billing data from
[SGP (Sistema de Gestão de Provedores)](https://sgp.net.br) through the provider's
own integration API. Once configured, an operator sees the contract, plan,
service status, and open invoices next to the ONT, and the customer portal can
show the subscriber their own open invoices and — optionally — request a trust
unlock ("liberação em confiança").

The panel only reads billing data, requests a trust unlock, and — when the
operator turns it on — opens a support ticket. It never creates, edits, or
settles invoices in SGP.

## What the panel calls

All requests are `POST` with a JSON body that carries the `app` and `token`
credentials plus one customer filter:

| Purpose | Default path | Filters sent |
| --- | --- | --- |
| Contract lookup | `/api/ura/consultacliente/` | `cpfcnpj`, `contrato`, or `login` |
| Open invoices | `/api/ura/titulos/` | `contrato` (or `cpfcnpj`), `limit`, `apenas_titulos_em_aberto` |
| Trust unlock | `/api/ura/liberacaopromessa/` | `contrato` |
| Open a ticket | `/api/ura/chamado/` | `contrato`, `conteudo`, `ocorrenciatipo`, optional `observacao` |
| Client listing | `/api/ura/clientes/` | optional `cpfcnpj`; the contacts sync adds its paging parameters |

Responses are read through a normalizing layer, so field spellings that differ
between SGP releases (`linhadigitavel`, `linha_digitavel`, `linhaDigitavel`) and
value formats (`129,90` or `129.90`, `10/10/2026` or `2026-10-10`) are all
accepted. Requests time out after 15 seconds.

## Setup

1. In SGP, open **Administração → Integrações → Tokens** and create a token.
   Note the *app* name and the generated token.
2. In TR69 Controle, open **Settings → SGP integration** as an administrator.
3. Fill in:
   - **SGP URL** — the provider base URL, e.g. `https://provedor.sgp.net.br`.
   - **App** and **Token** — the credentials from step 1.
   - **ONT to contract link** — which identifier is sent to SGP when a device
     has no contract linked yet:
     - *PPPoE login of the ONT* (default) — uses the PPPoE username the ONT reports.
     - *Panel Customer ID* — uses the panel's generated Customer ID.
     - *Manual link only* — no automatic lookup; an operator links each ONT.
   - **Invoices per query** — how many open invoices to request (1–24).
4. Use **Test connection** to verify. Without a sample customer the probe only
   confirms that the URL, app, and token are accepted; entering a CPF/CNPJ,
   contract number, or PPPoE login also verifies the lookup itself.
5. Enable **Enable the SGP integration** and save.

The token is encrypted with the shared secret box (AES-256-GCM, keyed from
`JWT_SECRET` under its own context) before being stored, and it is never
returned to the browser. Saving with an empty token
field keeps the stored one; **Remove token** clears it and disables the
integration.

> Because the key is derived from `JWT_SECRET`, changing that secret invalidates
> the stored token — re-enter it in Settings afterwards.

## Operator view

**Device Inventory → device → Overview** shows an *SGP integration* card with the
contract number, customer name, plan, and service status, followed by the open
invoices with their digitable line, PIX code, and second-copy link.

- **Refresh from SGP** re-queries SGP and refreshes the cached link.
- **Trust unlock** requests a trust unlock for the linked contract.
- **Open a ticket** files a ticket in SGP against the linked contract, seeded
  with the ONT id and its current optical reading. It appears only while ticket
  opening is enabled in Settings.
- **Unlink** removes the stored link so the ONT resolves again (or can be
  linked to a different contract).
- When automatic resolution finds nothing, the card offers a manual link by
  contract number.

### Opening a ticket

Off by default, because unlike everything else here it **writes to the ERP**.
Turn it on under *Settings → SGP*, where you also set the **Tipo de Ocorrência**
id new tickets are filed under — that id comes from your own SGP catalogue
(*Sistema → Ocorrências*). SGP's reference gives 5 as the default.

The request carries only the fields SGP documents for this route: `contrato`,
`conteudo`, `ocorrenciatipo`, and `observacao` when there is a note. Two nearby
fields are deliberately not sent. `setor` belongs to
`/api/ura/central/chamado/`, the subscriber-facing variant that authenticates
with `cpfcnpj`+`senha` rather than `app`+`token`. `conteudolimpo` only
suppresses SGP's default opening line, and the published references disagree on
its spelling.

The **response** shape is the one part of this route no reference documents. The
panel reads it tolerantly: it looks for the protocol number under `chamado`,
`protocolo`, `ocorrencia`, `os`, `ordemservico`, `id` and `numero`, and an
unrecognised body is reported as a success without a number — because the ticket
was still opened, and reporting a failure would have the operator open a second
one by phone.

Resolved links are cached in the `sgp_links` table, so day-to-day page loads do
not re-query SGP; the whole fleet is refreshed in one batch instead — see
*Fleet synchronization and reconciliation* below.

## Fleet synchronization and reconciliation

Beyond the per-device card, the integration works over the whole fleet.

### Derived contract state

`sgp_links` stores the SGP `status` and `status_label` exactly as the provider's
install words them, and adds a derived `state` that the panel can group by:

| State | Matched in the status or its label (case and accent insensitive) |
| --- | --- |
| `cancelled` | `cancelad`, `encerrad`, `desativad`, `inativ` |
| `blocked` | the SGP `bloqueado` flag, or `bloquead`, `suspens`, `inadimplen` |
| `active` | `ativo` |
| `unknown` | anything else |

Cancellations are matched first, so "Inativo" and "Desativado" are never read as
active; an explicit `bloqueado` flag outranks a label that still says "Ativo",
and a cancellation outranks the flag. The state is rewritten on every link
write, so links stored by an earlier release show `unknown` until the next sync.

### Batch synchronization

`POST /api/sgp/sync` resolves every device that has a panel customer account,
five at a time so the provider's SGP is never flooded. Manually linked ONTs keep
their contract: only their cached fields are refreshed, never the contract they
point at. A device that fails does not abort the run. The response — also stored
in `app_state` under `sgp_sync_last_run`, so the panel can show it after a
reload — counts:

| Field | Meaning |
| --- | --- |
| `total` | Customer accounts examined |
| `linked` | Devices holding a link when the run ended, including ones whose refresh failed but whose cached link survived |
| `created` | Links written for a device that had none |
| `updated` | Links refreshed for a device that already had one |
| `failed` | Devices whose SGP lookup errored |
| `skipped` | Devices with no identifier for the configured link mode, and lookups that matched no contract |
| `durationMs`, `startedAt`, `finishedAt` | Wall clock of the run |

### Reconciliation overview

`GET /api/sgp/overview` cross-references GenieACS freshness with the stored
contract states and reports the two divergences neither system sees alone:

- **`onlineBlocked`** — the ONT informed in the last 10 minutes while the
  contract is blocked or cancelled: a possible unauthorised reconnection.
- **`offlineActive`** — the contract is active but the ONT has not informed: a
  customer with a problem who has not called yet.
- **`unlinked`** — devices GenieACS knows that have no SGP link at all.

`totals` carries the full counts (`devices`, `linked`, `unlinked`,
`onlineBlocked`, `offlineActive`) and `byState` the linked contracts per derived
state; each list under `divergences` is a sample capped at 50 entries, so a
fleet-sized divergence stays readable. `lastSync` repeats the stored sync
summary, or is `null` before the first run.

### Contacts sync (every client, for WhatsApp)

Brings every SGP client into the WhatsApp **Contacts** tab — with or without a
contract, with or without equipment in the panel. It lives under
**Settings → SGP → Contacts for WhatsApp**.

The listing is `POST /api/ura/clientes/`, with the same `app` + `token` as every
other call:

```sh
curl --location '{{url}}/api/ura/clientes/' \
  --data '{ "app": "{{app}}", "token": "{{token}}", "cpfcnpj": "999.999.999-99" }'
```

Whether it lists every client **without** `cpfcnpj`, and which paging parameters
it honours, depends on the SGP version — the **Test** button answers both on the
install itself. The path is a setting (`endpoints.customerList`) for installs
that expose it elsewhere; the sync sends the paging parameters in the JSON body:

| Setting | Default | Meaning |
|---|---|---|
| `endpoints.customerList` | `/api/ura/clientes/` | Relative path of the client listing. An empty value falls back to the default. A leading Postman variable (`{{url}}/api/...`) is dropped, since the address comes from `baseUrl`; one left in the middle is refused. |
| `contactsPaging` | `offset` | `offset` sends a row offset; `page` sends a page number from 1 |
| `contactsOffsetParam` / `contactsLimitParam` | `offset` / `limit` | The parameter names the install expects |
| `contactsPageSize` | 100 | 10–500 |
| `contactsSyncEnabled` / `contactsSyncIntervalHours` | off / 24 | Runs on the scheduler, in the background |

The answer is read from the first array under `clientes`, `contratos`, `dados`,
`data`, `results` or `items`. Each entry may be a client with a nested
`contratos` list (one contact per contract), a contract row, or a client with no
contract (one contact, keyed by the client `id`). Phones are read from the usual
fields or from a `telefones`/`contatos` list, preferring a mobile.

**Test** reads the first page, writes nothing, and shows how many clients came
back and which fields they carry — use it to confirm the path before syncing.

A first page with no clients at all is reported as `partial` with reason
`empty` — most likely an install whose listing only answers with a filter —
rather than as a sync that found nobody. An outright refusal arrives with the
SGP's own message.

The **Search the SGP** button on the contacts screen uses the same endpoint with
`cpfcnpj` next to `consultacliente`: it is the only lookup that finds a client
with **no contract**. Only rows whose document matches the one typed are kept,
so an install that ignores the filter cannot turn a CPF search into a list of
strangers.

Safety: a page that repeats the previous one's first client (an SGP that ignores
the paging parameters) stops the run as `partial` with reason `paging_ignored`;
2 000 pages or 1 000 000 rows is a hard ceiling. Nothing is ever deleted: a client
removed from the SGP keeps its row and its conversations; a manually corrected
phone is never overwritten; a client that gains a contract has its contract-less
row retired and its conversations moved to the contract.

A page with MORE rows than the page size means the SGP ignored the limit and
sent its whole base at once: every row is stored, the run stops there and is
complete (`note: 'all_at_once'`). Listing calls get their own deadline (90 s,
under the proxy's 120 s) and body ceiling (64 MB); every other SGP call keeps
15 s and 4 MB.

Routes: `GET /api/sgp/contacts/sync` (`{ lastRun, running, lastError }`, `sgp.read`),
`POST /api/sgp/contacts/sync` (starts a run in the background and answers 202,
`sgp.act`; the screen polls the GET), `POST /api/sgp/contacts/test`
(first page only, `sgp.config`).

## Customer portal

Two portal options are configured in the same settings tab:

- **Show invoices in the customer portal** adds an *Invoices* section to the
  portal listing the subscriber's open invoices, with the CPF/CNPJ masked to its
  last four digits. Paid invoices are filtered out.
- **Allow trust unlock from the portal** adds a trust-unlock button. SGP still
  decides whether the request is granted.

The contract is always resolved from the authenticated portal session; the
browser cannot choose which contract is read. Both endpoints are rate limited
per customer account rather than per source address — 20 billing reads a minute
and 3 trust unlocks an hour — so one subscriber cannot exhaust the quota for
everyone behind the same proxy.

## Events and reconciliation

Everything above is read on demand: a payment that clears in SGP only reaches
the panel when somebody opens the page. Two mechanisms close that gap, and they
feed one another's handler, so there is a single path to reason about.

### Webhook

**Settings → SGP integration → Events and reconciliation** shows the address to
register in SGP:

```
https://<your panel host>/api/sgp/events/webhook
```

Generate a secret there first — it is shown **once**, encrypted at rest under
its own key, and never returned again. While *Accept events from SGP* is off,
the endpoint answers `404`, so an unauthenticated prober cannot learn whether
this panel talks to SGP at all.

A delivery must be signed with HMAC-SHA256 over the request body using that
secret. Because SGP's exact convention is not documented for integrators, the
panel accepts several shapes, all of which still require the secret:

- header `X-SGP-Signature`, `X-Signature`, `X-Hub-Signature-256` or
  `X-Webhook-Signature`, with or without a `sha256=` prefix;
- the digest in hex or base64;
- the signed payload being either the body alone or `<timestamp>.<body>`.

Turn on *Require a signed timestamp* only once SGP is confirmed to send one:
with it on, a delivery without a fresh timestamp is refused.

Verify a delivery by hand with:

```bash
BODY='{"evento":"pagamento_confirmado","contrato":"4321"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST -H 'Content-Type: application/json' \
  -H "X-SGP-Signature: sha256=$SIG" -d "$BODY" \
  https://panel.example.com/api/sgp/events/webhook
```

A valid delivery answers `202` and is processed in the background, so SGP never
waits on the panel's own round-trips. A redelivery answers `200` with
`duplicate: true` rather than an error — an error would make the sender retry
forever — and is stored only once.

### Reconciliation

Whether a given SGP install can push at all is not something the panel can
assume, so *Reconcile contracts periodically* covers the case where it cannot,
and catches deliveries that go missing. Each pass re-reads a page of linked
contracts straight from SGP, round-robin from a stored cursor so no link is
starved, and turns any change into the same kind of event a webhook would
produce.

This is not the same thing as the fleet synchronization above it, which walks
every device in one pass and refreshes each link without raising anything.
Reconciliation is the half that notices a contract *changed* and acts on it.

A transition is read from the normalized contract state (`active`, `blocked`,
`cancelled`), not from the provider's own label, which differs between installs.
A link that has never been read carries `unknown`; the first pass after an
upgrade fills that in without reporting a change that did not happen.

With the defaults — 25 contracts every 15 minutes — a base of 1,000 links is
swept in about 10 hours. Raise the batch or shorten the interval if that is too
slow for you, keeping in mind that each contract is one query against the
provider's billing system.

### What each event does

| Event | Action |
| --- | --- |
| Payment confirmed, unblocked, blocked | Re-reads the contract and refreshes the cached link, so the panel and the customer portal show the truth immediately |
| Cancelled | Refreshes, then unlinks the CPE so the equipment can be reused |
| Activated | Queues an automatic provisioning run, when automatic activation is on |
| Plan changed | Recorded only |
| Anything unrecognised | Stored as `unknown` with its body, so an operator can read it and extend the type map |

The panel never writes to a CPE in response to an event. Blocking a subscriber
is the network's job, not the panel's — a misread status would otherwise take a
paying customer offline.

A plan change is deliberately not acted on: silently rewriting a live
subscriber's WAN because a plan was renamed is dangerous, so it surfaces in the
event list and an operator decides whether to press **Provision now**.

### Extending the type map

The panel already recognises the usual Portuguese wordings
(`pagamento_confirmado`, `liberado`, `bloqueado`, `cancelado`, `ativado`,
`alteracao_plano` and several variants), compared ignoring accents, case and
separators. When your SGP uses something else, the event is stored as `unknown`
with its body; read it in the events list and add the mapping through
`PUT /api/sgp/config` in `eventTypeMap`.

## API reference

Operator endpoints (admin role required, `/api` on the panel port):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sgp/config` | Current configuration; never includes the token |
| `PUT` | `/api/sgp/config` | Update configuration (omit `token` to keep it) |
| `POST` | `/api/sgp/test` | Connectivity and credential probe |
| `GET` | `/api/sgp/customers?login=&contract=&document=` | Contract lookup |
| `GET` | `/api/sgp/links` | Every stored link, for the devices list |
| `GET` | `/api/sgp/overview` | Fleet reconciliation (divergences, states, last sync) |
| `POST` | `/api/sgp/sync` | Batch synchronization of the whole fleet |
| `GET` | `/api/sgp/devices/:deviceId?refresh=1` | Link plus open invoices for a device |
| `POST` | `/api/sgp/devices/:deviceId/link` | Manually link a contract |
| `DELETE` | `/api/sgp/devices/:deviceId/link` | Remove the link |
| `POST` | `/api/sgp/devices/:deviceId/unlock` | Request a trust unlock |
| `POST` | `/api/sgp/devices/:deviceId/ticket` | Open a ticket for the linked contract |
| `GET` | `/api/sgp/events` | Stored events, filterable by status and type |
| `GET` | `/api/sgp/events/:id` | One event, including its stored body |
| `POST` | `/api/sgp/events/:id/retry` | Reprocess a failed event |
| `POST` | `/api/sgp/events/secret/rotate` | Generate a webhook secret (returned once) |
| `POST` | `/api/sgp/reconcile` | Run one reconciliation pass now |

Plus one unauthenticated endpoint, where the shared secret is the credential:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/sgp/events/webhook` | Receive an event from SGP |

Customer portal endpoints (portal session required, portal port):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/customer/billing` | Contract summary and open invoices |
| `POST` | `/api/customer/billing/trust-unlock` | Request a trust unlock |

Errors carry a machine-readable `code`: `not_configured`, `unlinked`,
`not_found`, `unauthorized`, `timeout`, `unreachable`, `sgp_rejected`,
`invalid_response`.

All panel and portal strings for the integration go through the panel's
translation dictionaries (`pt-BR`, `en`, `es`), so the labels above appear in
the reader's language. Two kinds of text are not translated: values that come
from SGP itself (contract status, plan name, invoice description) are shown
exactly as the provider's system returns them, and the API error messages in
the table below are returned in Portuguese, like the rest of this API's
messages.

## Troubleshooting reference

| Symptom | Likely cause |
| --- | --- |
| "O SGP recusou as credenciais de integração" | Wrong app/token, or the token has no permission for the URA endpoints |
| "Este ONT ainda não tem contrato do SGP vinculado" | The ONT reports no PPPoE username, or the login does not match SGP; link manually |
| "O SGP não respondeu dentro do tempo limite" | Network path or firewall between the panel and SGP |
| Invoices missing while the contract loads | The provider's SGP install restricts the `titulos` endpoint for this token |
| Custom integration paths | Endpoint paths are stored per install and can be adjusted through `PUT /api/sgp/config` (`endpoints.customer`, `endpoints.invoices`, `endpoints.unlock`) |
| Every webhook delivery returns 404 | Event delivery is off, or no secret has been generated |
| Every webhook delivery returns 401 | Wrong secret, or *Require a signed timestamp* is on and SGP does not send one |
| Webhook returns 403 with "Origin is not allowed" | A proxy in front of the panel is adding an `Origin` header. Server-to-server calls send none; add that origin to `CORS_ORIGINS` |
| Events arrive but nothing changes | The event's contract has no CPE linked to it yet |
