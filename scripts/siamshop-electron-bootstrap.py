#!/usr/bin/env python3
"""SIAMSHOP-ELECTRON-001 prerequisite bootstrap — run by Korakot, locally.

Does the two GitHub-side jobs Joy can't do:
  1. creates the PUBLIC kongponsrisiri-coder/siamshop-releases repo (auto-update target)
  2. uploads the 6 release secrets to the (private) Siam-Shop code repo so the
     copied release.yml can sign + notarize + publish.

Reads GITHUB_TOKEN from Control Room's .infra-keys. Prompts for the two Apple
passwords (never stored anywhere). Idempotent — re-run to rotate a secret.
Usage:  python3 scripts/siamshop-electron-bootstrap.py
"""
import base64, getpass, json, os, sys, urllib.request

OWNER      = 'kongponsrisiri-coder'
CODE_REPO  = 'Siam-Shop'
REL_REPO   = 'siamshop-releases'
P12_PATH   = os.path.expanduser('~/Documents/SiamEPOS-DevID.p12')
APPLE_ID   = 'thethaiclapham@hotmail.com'
TEAM_ID    = 'G6D63G9WVY'
KEYS       = os.path.expanduser('~/Library/Application Support/SiamEPOS Control Room/.infra-keys')

try:
    from nacl import encoding, public
except ImportError:
    sys.exit('pynacl missing → run:  pip3 install --user pynacl   then re-run')

tok = next((l.split('=', 1)[1].strip().strip('"') for l in open(KEYS)
            if l.startswith('GITHUB_TOKEN=')), None) or sys.exit('GITHUB_TOKEN not in .infra-keys')

def gh(method, path, body=None):
    req = urllib.request.Request('https://api.github.com' + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'token ' + tok, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, (json.loads(r.read() or b'{}') if r.status != 204 else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

# 1. releases repo
st, _ = gh('GET', f'/repos/{OWNER}/{REL_REPO}')
if st == 200:
    print(f'✓ {REL_REPO} already exists')
else:
    st, r = gh('POST', '/user/repos', {'name': REL_REPO, 'private': False, 'auto_init': True,
        'description': 'SiamShop desktop till — public release feed for auto-update (no source code)'})
    print(f'{"✓ created" if st == 201 else "✗ FAILED"} {REL_REPO}  {r.get("message", "")}')
    if st != 201: sys.exit(1)

# 2. secrets → code repo
st, pk = gh('GET', f'/repos/{OWNER}/{CODE_REPO}/actions/secrets/public-key')
if st != 200: sys.exit(f'✗ cannot read {CODE_REPO} secrets public key ({st}) — token needs repo scope + admin on the repo')
box = public.SealedBox(public.PublicKey(pk['key'].encode(), encoding.Base64Encoder()))
def put_secret(name, value):
    enc = base64.b64encode(box.encrypt(value.encode())).decode()
    st, r = gh('PUT', f'/repos/{OWNER}/{CODE_REPO}/actions/secrets/{name}',
               {'encrypted_value': enc, 'key_id': pk['key_id']})
    print(f'{"✓" if st in (201, 204) else "✗"} {name}  {r.get("message", "")}')

if not os.path.exists(P12_PATH): sys.exit(f'✗ cert not found at {P12_PATH}')
p12_b64 = base64.b64encode(open(P12_PATH, 'rb').read()).decode()
print('\nTwo passwords needed (typed here only, sent encrypted to GitHub, never stored):')
p12_pw = getpass.getpass('  .p12 certificate password: ')
app_pw = getpass.getpass('  Apple app-specific password (xxxx-xxxx-xxxx-xxxx): ')

put_secret('MAC_CERT_P12_BASE64',    p12_b64)
put_secret('MAC_CERT_PASSWORD',      p12_pw)
put_secret('MAC_APPLE_ID',           APPLE_ID)
put_secret('MAC_APPLE_APP_PASSWORD', app_pw)
put_secret('MAC_TEAM_ID',            TEAM_ID)
put_secret('RELEASES_REPO_TOKEN',    tok)   # same PAT — repo scope lets the workflow publish to siamshop-releases
print('\nDone. Joy can now tag v0.1.0 in Siam-Shop once release.yml + build config are in.')
print('Tip: validate the Apple trio in 5 s before any 30-min CI wait:')
print(f'  xcrun notarytool history --apple-id "{APPLE_ID}" --team-id "{TEAM_ID}" --password "<app password>"')
