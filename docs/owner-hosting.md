# Private Mini Planet owner hosting

`scripts/owner-server.py` serves the existing built Mini Planet and a narrow,
authenticated read-only bridge to the **existing controller** on the same machine.
It uses Python 3.10+ standard libraries only. It does not install, launch, restart,
or change Hermes, its profiles, the controller, or any scheduled job.

```text
Browser /?owner=1
  └─ same-origin HttpOnly owner session
      └─ owner-server.py (127.0.0.1 only)
          └─ existing controller (127.0.0.1, explicitly supplied port)
```

The public static app can be loaded without login. Private API responses require
the owner session. The controller key stays in the Python process and is never
put in JavaScript, localStorage, HTML, URLs, or a browser response. This owner
surface is separate from the public observer and its curated publication data.

## Prepare on the Mac mini

These are preparation commands, not evidence that the Mac mini has been
configured or connected. The supplied controller report identifies this checkout:

```sh
cd /Users/rodiclawmini/.hermes/workspace/projects/mini-planet-controller
python3 ctl.py status
```

Read its **current loopback port** from that status output. The report identifies
`.private/client-key` under this directory as the key file; its one-line format
has not been verified here. Do not assume the Hermes API port is the controller
port, print the key, or run an install/restart command to find the port.

From the Mini Planet checkout on the Mac mini:

```sh
node scripts/build-site.mjs
python3 -m unittest discover -s tests -p test_owner_server.py -v
```

The build command creates `_site`. The server requires an explicit build root
and rejects a checkout containing scripts, tests, or other non-public entries.
The test suite uses temporary files and a fake loopback controller; it does not
read production secrets or contact Hermes.

For a later build update, stop only this owner server, rebuild or replace `_site`,
then start the owner server again. The static root is opened once at startup;
deleting and recreating that directory while serving does not switch the open
directory handle. No Hermes/controller restart is required.

Create a separate owner password outside both the checkout and `_site`:

```sh
MP_PRIVATE_DIR="$HOME/.config/mini-planet-owner"
mkdir -p "$MP_PRIVATE_DIR"
chmod 700 "$MP_PRIVATE_DIR"
python3 - "$MP_PRIVATE_DIR/owner-password" <<'PY'
import getpass
import os
import sys

first = getpass.getpass('New Mini Planet owner password: ')
second = getpass.getpass('Repeat password: ')
if not first or first != second:
    raise SystemExit('Passwords must be nonempty and match.')
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as stream:
    stream.write(first + '\n')
PY
```

Use a unique password. The exclusive create intentionally refuses to overwrite
an existing password. Secret inputs must be one nonempty line in a regular file
owned by the server user, with no group/other permissions (`600` or `400`).
Symlink secret files are rejected. The password must differ from the controller
key. If the controller stores its key in a structured configuration file, create
a private one-line key file locally; do not copy the configuration into `_site`,
paste the key into a command, or send it through chat.

Supply the values confirmed by the local controller status check:

```sh
MP_CONTROLLER_PORT='REPLACE_WITH_CURRENT_CONTROLLER_PORT'
MP_CONTROLLER_KEY_FILE='/Users/rodiclawmini/.hermes/workspace/projects/mini-planet-controller/.private/client-key'
MP_OWNER_PORT=8787
python3 scripts/owner-server.py \
  --root "$PWD/_site" \
  --controller-url "http://127.0.0.1:$MP_CONTROLLER_PORT" \
  --controller-key-file "$MP_CONTROLLER_KEY_FILE" \
  --password-file "$MP_PRIVATE_DIR/owner-password" \
  --port "$MP_OWNER_PORT"
```

The server prints its owner URL. Open that loopback URL with `/?owner=1` on the
Mac mini, then sign in. A `502 controller_unavailable` means the existing
controller, route, or response needs inspection; the owner server does not
restart anything or fall back to a different engine. A successful status read
does not prove that other controller routes or all profiles are supported.

## Access from another computer

For personal access, keep the server loopback-bound and use an SSH local tunnel
with the **same owner port** at both ends:

```sh
ssh -N -L "127.0.0.1:$MP_OWNER_PORT:127.0.0.1:$MP_OWNER_PORT" YOUR_MAC_MINI_SSH_ALIAS
```

Open `http://127.0.0.1:<owner-port>/?owner=1` locally. Matching the ports matters
because the server validates Host and Origin. The SSH connection encrypts the
remote hop. Do not bind this Python service to a LAN/public address.

For an existing HTTPS reverse proxy, add exactly:

```sh
--public-origin 'https://YOUR-PRIVATE-OWNER-HOST'
```

The value is one exact HTTPS origin, without a path or trailing slash. The proxy
must preserve the public `Host` and browser `Origin`, forward to the loopback
owner port, disable caching for the whole owner host, and terminate TLS. In this
mode the cookie is `Secure`; direct HTTP browser login is intentionally unusable.
Forwarded headers do not override origin validation. Use a dedicated owner
hostname so an old public Mini Planet service worker cannot intercept owner
requests. No GitHub Pages setting or public publication mode needs changing.

## Browser contract

All browser calls use the same origin, `credentials: 'same-origin'`, and
`cache: 'no-store'`. POST uses `Content-Type: application/json`. Normal browser
fetch supplies Origin for POST/DELETE; missing, cross-site, and mismatched
origins are rejected. There is no CORS API.

| Request | Result |
| --- | --- |
| `GET /owner/session` | `200 {authenticated:true,expiresAt:<ISO UTC>}` or `401 {authenticated:false,error:"authentication_required"}` |
| `POST /owner/session` with `{password:<string>}` | Success JSON above and opaque session cookie; invalid password `401`; throttle `429` |
| `DELETE /owner/session` | `200 {authenticated:false}`, server session invalidated, cookie cleared |
| `GET /api/v1/status` | Authenticated controller JSON |
| `GET /api/v1/board` | Authenticated controller JSON |
| `GET /api/v1/jobs?profile=default` | Authenticated jobs; exactly one `profile`, limited to `default`, `rodi`, `jarvis` |
| `GET /api/v1/results/rodi` | Authenticated Rodi results |

No other API route, mutation, query parameter, or profile is forwarded. API
boundary errors are JSON `{error:<code>}`. Successful controller replies require
status 200 and JSON. For board/jobs/Rodi results, a documented HTTP 503 failure
envelope is also preserved: exactly `source:"dashboard"`, `status:"error"`,
timezone-aware `observed_at`, `last_success_at:null`, `expires_at:null`,
`stale:true`, a bounded nonempty `error` string, and `data:null`. This retains the
distinction between controller-reported unavailability and a bridge failure.
Other errors, redirects, non-JSON, oversized, unavailable, or secret-echo responses
become a sanitized `502`. Browser Authorization and Cookie headers are not forwarded;
only the locally loaded controller bearer is sent upstream.

Sessions expire after eight hours and are kept in memory; owner-server restart
logs everyone out. Re-login rotates the current session. Cookies are HttpOnly,
SameSite=Strict, and host-only. Login permits five failures per rolling minute
across this private server, then returns `Retry-After: 60`.

Bounds: 16 simultaneous requests, 4 KiB request body, 32 KiB headers, 4 KiB
request target, ten-second request lifetime, five-second controller deadline,
2 MiB controller response, and 32 MiB static file. Responses are `no-store` and
`nosniff`; upstream headers/cookies are not relayed. Public static paths cannot
traverse directories, list directories, follow symlinks, or expose dotfiles or
`services.local.json`.

For rollback, stop only this foreground owner server and close its tunnel or
proxy route. The public site and existing controller/Hermes services continue
unchanged. This script deliberately does not create a launch agent or daemon.
