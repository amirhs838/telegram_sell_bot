#!/usr/bin/env python3
"""Login as the temp self-check admin and read the panel's own Gemini key statuses."""
import importlib.util
import json

spec = importlib.util.spec_from_file_location('slf', '/home/z/my-project/scripts/selfcheck-studio.py')
slf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slf)

st, pl, _ = slf.req('POST', '/api/auth/login', body={'email': slf.EMAIL, 'password': slf.PW})
tok = slf.jbody(pl).get('token', '')
print('login', st, 'token', 'yes' if tok else 'no')
st, pl, _ = slf.req('GET', '/api/ai/gemini-keys', token=tok, timeout=30)
d = slf.jbody(pl)
print('gemini-keys status', st)
keys = d.get('keys') or d.get('statuses') or d
if isinstance(keys, dict):
    keys = keys.get('keys', [])
now_ms = slf.time.time() * 1000
for k in keys if isinstance(keys, list) else []:
    pu = k.get('parkedUntil')
    parked_min = round((pu - now_ms) / 60000) if pu else None
    print(f"  fp={k.get('fingerprint')} source={k.get('source')} parkKind={k.get('parkKind')} parkedInMin={parked_min}")
if not isinstance(keys, list):
    print(json.dumps(d, ensure_ascii=False)[:400])
