#!/usr/bin/env python3
"""Image Studio end-to-end self-check (preset + custom background).
Runs against http://83.228.251.30 from outside. Prints a SUMMARY line at the end.
"""
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

BASE = 'http://83.228.251.30'
EMAIL = 'selfcheck-studio@shop.local'
PW = 'TempStudio!2026x'
OUT = '/tmp/slf'
os.makedirs(OUT, exist_ok=True)


def req(method, path, token=None, body=None, raw=None, ctype=None, timeout=240):
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if raw is not None:
        data = raw
        headers['Content-Type'] = ctype
    if token:
        headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read(), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read(), time.time() - t0
    except Exception as e:  # connection-level failure
        return 0, str(e).encode('utf-8'), time.time() - t0


def jbody(payload):
    try:
        return json.loads(payload.decode('utf-8'))
    except Exception:
        return {}


def gen_png(path, w=256, h=256, g=0x88):
    row = b'\x00' + bytes([g]) * w
    raw = row * h

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


def multipart(path, field, filename, mime):
    boundary = 'slfselfcheck42'
    with open(path, 'rb') as f:
        content = f.read()
    head = (f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f'Content-Type: {mime}\r\n\r\n').encode('utf-8')
    tail = f'\r\n--{boundary}--\r\n'.encode('utf-8')
    return head + content + tail, f'multipart/form-data; boundary={boundary}'


def verify_png(path):
    with open(path, 'rb') as f:
        b = f.read()
    sig = b[:8] == b'\x89PNG\r\n\x1a\n'
    verdict = 'PASS' if (sig and len(b) > 2000) else 'FAIL'
    print(f'    download size={len(b)} png_sig={"OK" if sig else "BAD"} -> {verdict}')
    return verdict == 'PASS'


def main():
    print('== 1. login')
    st, pl, ms = req('POST', '/api/auth/login', body={'email': EMAIL, 'password': PW})
    tok = jbody(pl).get('token', '')
    print(f'    status={st} dur={ms:.1f}s token={"yes" if tok else "no"}')
    if not tok:
        print('LOGIN_FAILED:', pl[:300].decode('utf-8', 'replace'))
        return 1

    print('== 2. gray png')
    n = gen_png(f'{OUT}/selfcheck.png')
    print(f'    png_bytes={n}')

    print('== 3. upload')
    mp, ct = multipart(f'{OUT}/selfcheck.png', 'file', 'selfcheck.png', 'image/png')
    st, pl, ms = req('POST', '/api/uploads', token=tok, raw=mp, ctype=ct, timeout=60)
    up = jbody(pl)
    upurl = up.get('url', '')
    print(f'    status={st} dur={ms:.1f}s resp={json.dumps(up, ensure_ascii=False)[:200]}')
    if not upurl:
        print('UPLOAD_FAILED:', pl[:300].decode('utf-8', 'replace'))
        return 1
    upname = upurl.rsplit('/', 1)[-1]

    print('== 4. first product')
    st, pl, ms = req('GET', '/api/products?pageSize=5', token=tok, timeout=30)
    d = jbody(pl)
    ps = d.get('products') or d.get('items') or (d if isinstance(d, list) else [])
    pid = ps[0]['id'] if ps else ''
    print(f'    status={st} products={len(ps)} pid={pid or "-"}')
    if not pid:
        print('NO_PRODUCT:', pl[:300].decode('utf-8', 'replace'))
        return 1

    def studio(tag, body):
        print(f'== {tag}')
        st, pl, ms = req('POST', f'/api/products/{pid}/studio', token=tok, body=body)
        d = jbody(pl)
        job = d.get('job') or {}
        furl = job.get('finalUrl') or ''
        err = d.get('error') or job.get('error') or ''
        print(f'    status={st} dur={ms:.1f}s finalUrl={furl or "-"}')
        if err:
            print(f'    error: {err}')
        if not furl:
            return None
        fn = furl.rsplit('/', 1)[-1]
        st2, pl2, _ = req('GET', furl, timeout=60)
        with open(f'{OUT}/dl_{tag}.png', 'wb') as f:
            f.write(pl2)
        print(f'    download status={st2}')
        ok = (st2 == 200) and verify_png(f'{OUT}/dl_{tag}.png')
        return {'finalUrl': furl, 'name': fn, 'ok': ok}

    resA = studio('5A studio black_luxury', {'action': 'generate', 'imageUrl': upurl, 'backgroundKey': 'black_luxury'})
    resB = studio('5B studio custom', {'action': 'generate', 'imageUrl': upurl, 'backgroundKey': 'custom',
                                       'customPrompt': 'پس‌زمینه چوب گرم با نور غروب'})

    a = 'PASS' if (resA and resA['ok']) else 'FAIL'
    b = 'PASS' if (resB and resB['ok']) else 'FAIL'
    state = {'upname': upname, 'finals': [x['name'] for x in (resA, resB) if x]}
    with open(f'{OUT}/state.json', 'w') as f:
        json.dump(state, f)
    print(f'SUMMARY testA={a} testB={b} upname={upname} finals={state["finals"]}')
    return 0 if (a == 'PASS' and b == 'PASS') else 2


if __name__ == '__main__':
    sys.exit(main())
