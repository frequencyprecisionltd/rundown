#!/usr/bin/env python3
"""Work on the board data without any outside database.

The encrypted file data.enc.json in this repository is the full record of the board
(roles, speculative emails, CV, handover notes, links). This tool turns it back into
plain JSON files, so any person or AI agent can add to it and publish again.

  python3 tools/rundown_data.py export <folder>     decrypt data.enc.json into <folder>/jobs, <folder>/outreach, <folder>/profile
  python3 tools/rundown_data.py add <folder> <file.json> [...]
                                                    copy new role or speculative email files into <folder>
                                                    (a file with "employer" goes to jobs, one with "org" goes to outreach;
                                                     existing ids are never overwritten)
  then publish with tools/publish.sh <folder>

The page password is read from the environment variable RUNDOWN_PW. Nothing secret is stored here.
"""
import base64, json, os, re, sys, shutil
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def decrypt(path, pw):
    d = json.load(open(path)); b = base64.b64decode
    k = PBKDF2HMAC(hashes.SHA256(), 32, b(d['salt']), d['iter']).derive(pw.encode())
    return json.loads(AESGCM(k).decrypt(b(d['iv']), b(d['ct']), None))

def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh: json.dump(obj, fh, ensure_ascii=False, indent=1)

def export(folder):
    pw = os.environ.get('RUNDOWN_PW') or sys.exit('Set RUNDOWN_PW to the page password first.')
    data = decrypt(os.path.join(HERE, 'data.enc.json'), pw)
    for kind in ('jobs', 'outreach'):
        for rec in data.get(kind, []):
            rec = dict(rec); rid = rec.pop('id')
            write(os.path.join(folder, kind, rid + '.json'), rec)
    if data.get('cvbase'): write(os.path.join(folder, 'profile', 'cvbase.json'), data['cvbase'])
    if data.get('handover'): write(os.path.join(folder, 'profile', 'handover.json'), data['handover'])
    write(os.path.join(folder, 'profile', 'links.json'), {
        'items': data.get('links', []), 'site': data.get('publicSite', ''), 'edit': data.get('siteEdit', ''),
        'preview': data.get('sitePreview', ''), 'account': data.get('siteAccount', ''), 'password': data.get('sitePassword', '')})
    if data.get('api'): print('Service address and key are inside: set RUNDOWN_API_URL and RUNDOWN_API_TOKEN to', 'the values shown by:  python3 tools/rundown_data.py api')
    print('Exported %d roles and %d speculative emails to %s' % (len(data.get('jobs', [])), len(data.get('outreach', [])), folder))

def show_api():
    data = decrypt(os.path.join(HERE, 'data.enc.json'), os.environ['RUNDOWN_PW'])
    a = data.get('api') or {}
    print("export RUNDOWN_API_URL='%s'\nexport RUNDOWN_API_TOKEN='%s'" % (a.get('url', ''), a.get('token', '')))

def slug(s): return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:90]

def add(folder, files):
    for f in files:
        rec = json.load(open(f, encoding='utf-8'))
        kind = 'jobs' if 'employer' in rec else 'outreach' if 'org' in rec else None
        if not kind: print('Skipped (not a role or speculative email):', f); continue
        rid = rec.pop('id', None) or slug((rec.get('employer', '') + ' ' + rec.get('title', '')) if kind == 'jobs' else rec['org'])
        dest = os.path.join(folder, kind, rid + '.json')
        if os.path.exists(dest): print('Already there, skipped:', rid); continue
        rec.setdefault('status', 'new'); write(dest, rec); print('Added', kind, rid)

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['export'] and len(a) == 2: export(a[1])
    elif a[:1] == ['api']: show_api()
    elif a[:1] == ['add'] and len(a) >= 3: add(a[1], a[2:])
    else: sys.exit(__doc__)
