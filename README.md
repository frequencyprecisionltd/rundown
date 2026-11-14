# rundown

A small private page. The data file is encrypted; the page asks for a password.

`build_data.py <db_dir> . <password>` regenerates `data.enc.json`.

## Working without any outside database

`data.enc.json` is the full record of the board. With the page password in `RUNDOWN_PW`:

- `python3 tools/rundown_data.py export work` turns it back into plain files in `work/`
- `python3 tools/rundown_data.py add work new-role.json ...` adds new roles or speculative emails
- `tools/publish.sh work` rebuilds the encrypted file, runs the leak check (`RUNDOWN_LEAK`) and commits; then `git push`

Needs python3 and the `cryptography` package. The private notes inside the encrypted data explain the rest.
