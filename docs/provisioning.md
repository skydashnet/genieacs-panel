# Automatic provisioning

TR69 Controle can activate a new subscriber's ONT on its own: when an ONT informs,
the panel resolves its SGP contract from the PPPoE login the device already
reports, matches the contract's plan against a **provisioning profile**, and
writes the WiFi settings, the CPE administrative password, and the PPPoE WAN.

Everything here is off until an operator turns it on, and every action an
operator can trigger has a dry run.

## What this assumes

The ONT arrives with its **PPPoE login already set** — provisioned by the OLT or
whatever auto-configures the ONU. That login is the identity used to find the
contract. The panel then writes the login *and* the password from SGP over it,
which is also what makes a device swap reapply the contract's profile later.

An ONT that reports no PPPoE login cannot be resolved to a contract, and the run
is recorded as skipped with that reason.

## Profiles

Open **Settings → Automatic activation**. A profile decides what is written:

| Field | Effect |
| --- | --- |
| Plan patterns | Case-insensitive substrings matched against the plan name SGP returns |
| Use when no pattern matches | Marks this profile as the fallback |
| Priority | Higher wins when more than one profile matches |
| WAN VLAN, service list | Written when the ONT exposes a writable parameter for them |
| WLAN indexes, SSID template | Which radios to configure and how to name them |
| WiFi password | Generated per ONT, fixed for the profile, or left alone |
| CPE password | The administrative credential, written to the configured virtual parameter |

Matching is by substring, not by regular expression. An operator-supplied regex
is both easy to get wrong and a denial-of-service risk, and the vendor table
already works this way. A profile with no patterns does **not** become a
catch-all either — the fallback is the explicit checkbox, so clearing a field
cannot silently start provisioning every plan.

The SSID template accepts `{contract}`, `{login}`, `{name}`, `{plan}`,
`{serial}` and `{serial4}` (the last four characters of the serial number).

WiFi passwords have three modes; the generated one is stored encrypted and can
be revealed from the device page, like any WiFi password the portal changes.
The CPE administrative password has no generated mode: nothing can read it back
from the ONT, and locking an operator out of a subscriber's equipment is worse
than a shared per-profile credential.

## What a run does

Steps run in this order:

1. **WiFi** — SSID and password for each configured WLAN index.
2. **CPE credentials** — the administrative password, if the profile applies one.
3. **WAN** — PPPoE username and password, VLAN, service list.

WAN is last on purpose. It rewrites the PPPoE credentials and can bounce the
session that TR-069 itself rides on, so anything queued behind it would be lost.
The ONT reaches the panel already dialling, so there is nothing to gain by going
first.

Around those steps, a run also creates the customer portal account, links the
CPE to its SGP contract, and — once the values are confirmed — tags the device
in GenieACS.

Every step is recorded. **Device page → Automatic provisioning** shows the last
run with its per-step outcome, and **Settings → Automatic activation** lists the
most recent runs across the fleet. That record is how you answer "why did that
activation not take".

### Confirming that it worked

GenieACS answers `200` when the connection request reached the CPE and the task
ran, and `202` when the task was only queued for a later inform. A `202` is
recorded as queued, never as applied.

With **Confirm the values afterwards** on (the default), a run then waits and
re-reads the ONT, comparing what it reports against what was written. Only then
is it marked successful and tagged. The deadline for that check lives in the run
row rather than in a timer, so restarting the service resumes the check instead
of losing the run.

Passwords are never part of that comparison: most CPEs return an empty or masked
value for `Password` and `KeyPassphrase`, so comparing them would fail runs that
actually worked.

### When something fails

A failed step stops the run — a half-written WAN is worse than a clean retry —
and everything already applied stays applied. The run is retried after 5, 15, 60
and 240 minutes, and then marked permanently failed so no device can cycle
forever. Re-running is safe: the panel only writes parameters that are writable
and actually different, so a retry against a partly-configured ONT is a no-op
for the parts that already took.

A step whose target parameter does not exist on that model — a CPE with no VLAN
node, for instance — is recorded as skipped rather than failed.

## The poller

While automatic activation is on, the panel scans GenieACS on the configured
interval for ONTs that:

- have informed within the inform window,
- report a PPPoE login,
- do not carry the provisioned tag, and
- have no run that already settled them.

Filtering happens in the panel rather than in a GenieACS query. Query-language
support varies between GenieACS versions, and a query the server does not
understand returns nothing — provisioning would then stop silently rather than
visibly.

The database is the authority on what has been provisioned; the GenieACS tag is
a marker for the GenieACS UI and a safety net if the panel database is ever
rebuilt.

## Limits worth knowing

- **TR-181 is not covered.** The WAN and WiFi paths are TR-098
  (`InternetGatewayDevice.*`), as everywhere else in the panel.
- **A factory ONT with no PPPoE WAN instance is not provisioned.** The run
  records `no_pppoe_wan` rather than creating the object, because an `addObject`
  against the wrong container can break service on a live ONT.
- **The PPPoE password depends on the SGP install.** The panel reads it through
  the same tolerant field lookup the rest of the integration uses, but if the
  contract query returns no password, only the login is written. Turn on
  **Require the PPPoE password from SGP** to make that stop the run instead.

## Schema

The three tables (`provisioning_profiles`, `provisioning_runs`, `sgp_events`)
are created by the `0006_provisioning_and_sgp_events` migration, so an existing
installation picks them up on the first boot after upgrading and a fresh one
gets them with the rest of the schema.

## API reference

Administrator endpoints on the panel port:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`PUT` | `/api/provisioning/config` | Poller settings |
| `GET`/`POST` | `/api/provisioning/profiles` | List and create profiles |
| `PUT`/`DELETE` | `/api/provisioning/profiles/:id` | Update and delete |
| `GET` | `/api/provisioning/runs` | Recent runs, filterable |
| `GET` | `/api/provisioning/devices/:deviceId/runs` | One device's history |
| `POST` | `/api/provisioning/devices/:deviceId/preview` | Dry run |
| `POST` | `/api/provisioning/devices/:deviceId/provision` | Provision now |
| `POST` | `/api/provisioning/run` | Run one poller pass |

No response from any of these carries a password. The preview reports whether
SGP returned a PPPoE password as a boolean, and masks every secret in the
parameter list it shows.
