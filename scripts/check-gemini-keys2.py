import importlib.util
import json

spec = importlib.util.spec_from_file_location('slf', '/home/z/my-project/scripts/selfcheck-studio.py')
slf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slf)

st, pl, _ = slf.req('POST', '/api/auth/login', body={'email': slf.EMAIL, 'password': slf.PW})
tok = slf.jbody(pl).get('token', '')
st, pl, _ = slf.req('GET', '/api/ai/gemini-keys', token=tok, timeout=30)
d = slf.jbody(pl)
print('status', st, 'count', d.get('count'), 'readyCount', d.get('readyCount'))
for k in d.get('keys', []):
    print(f"  fp={k.get('fingerprint')} source={k.get('source')} parked={k.get('parked')} kind={k.get('parkKind')} untilTehran={k.get('parkedUntilTehran')}")
