#!/usr/bin/env python3
"""Pack the rundown board data into an encrypted file for the public website.

Usage: RUNDOWN_API_URL=... RUNDOWN_API_TOKEN=... python3 build_data.py <db_dir> <out_dir> <password> [--standalone]
(the two variables are optional and switch on CV sharing)

<db_dir> holds jobs/*.json, outreach/*.json and optionally profile/cvbase.json as saved by ArtifactData list with out_dir.
Writes <out_dir>/data.enc.json (AES-GCM, key from PBKDF2-SHA256). With --standalone it also
writes <out_dir>/standalone.html, a single file with the encrypted data built in.
Only encrypted data is ever written, so the files are safe in a public repository.
"""
import base64, glob, json, os, sys, datetime
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 250000
KEEP_JOB = ["title","employer","category","location","hours","pay","fte","closing","why","url","added","status","draft","applyEmail"]
KEEP_OUT = ["org","country","sector","why","url","contact","contactNote","subject","email","language","added","status"]

def load(folder, keep):
    items = []
    for f in sorted(glob.glob(os.path.join(folder, "*.json"))):
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        rec = {k: d.get(k) for k in keep if k in d}
        rec["id"] = os.path.splitext(os.path.basename(f))[0]
        items.append(rec)
    return items

def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    db, out, pw = sys.argv[1], sys.argv[2], sys.argv[3]
    data = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "jobs": load(os.path.join(db, "jobs"), KEEP_JOB),
        "outreach": load(os.path.join(db, "outreach"), KEEP_OUT),
    }
    base = os.path.join(db, "profile", "cvbase.json")
    if os.path.exists(base):
        with open(base, encoding="utf-8") as fh:
            b0 = json.load(fh)
        data["cvbase"] = {"cv": b0.get("cv"), "label": b0.get("label", "General CV")}
    ho = os.path.join(db, "profile", "handover.json")
    if os.path.exists(ho):
        with open(ho, encoding="utf-8") as fh:
            h0 = json.load(fh)
        data["handover"] = {"text": h0.get("text", ""), "updated": h0.get("updated", "")}
    lk = os.path.join(db, "profile", "links.json")
    if os.path.exists(lk):
        with open(lk, encoding="utf-8") as fh:
            l0 = json.load(fh)
        data["links"] = l0.get("items", [])
        data["publicSite"] = l0.get("site", "")
    if os.environ.get("RUNDOWN_API_URL") and os.environ.get("RUNDOWN_API_TOKEN"):
        data["api"] = {"url": os.environ["RUNDOWN_API_URL"], "token": os.environ["RUNDOWN_API_TOKEN"]}
    if not data["jobs"]:
        sys.exit("No jobs found, refusing to publish an empty board.")
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(pw.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(data, ensure_ascii=False).encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    blob = {"v": 1, "iter": ITER, "salt": b(salt), "iv": b(iv), "ct": b(ct)}
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "data.enc.json"), "w") as fh:
        json.dump(blob, fh)
    if "--standalone" in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        inject = "<script>window.EMBEDDED_DATA=" + json.dumps(blob) + ";</script>\n<script src=\"https://cdnjs"
        html = html.replace("<script src=\"https://cdnjs", inject, 1)
        with open(os.path.join(out, "standalone.html"), "w", encoding="utf-8") as fh:
            fh.write(html)
    print(f"ok: {len(data['jobs'])} jobs, {len(data['outreach'])} outreach")

if __name__ == "__main__":
    main()
