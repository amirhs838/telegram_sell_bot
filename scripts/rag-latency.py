#!/usr/bin/env python3
"""Measure RAG assistant latency: real customer-style questions through /api/bot/simulate."""
import importlib.util
import time

spec = importlib.util.spec_from_file_location('slf', '/home/z/my-project/scripts/selfcheck-studio.py')
slf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slf)

st, pl, _ = slf.req('POST', '/api/auth/login', body={'email': slf.EMAIL, 'password': slf.PW})
tok = slf.jbody(pl).get('token', '')
print('login', st)

QUESTIONS = [
    ('q1-greeting', 'سلام، گردنبند نقره ۹۲۵ دارید؟ قیمتش چنده؟'),
    ('q2-shipping', 'هزینه ارسال چقدره و چند روزه میرسه؟'),
    ('q3-product', 'انگشتر نقره زنانه دارید؟ سایزبندی داره؟'),
]

for tag, q in QUESTIONS:
    st, pl, ms = slf.req('POST', '/api/bot/simulate', token=tok,
                         body={'telegramUserId': '990001', 'text': q}, timeout=60)
    d = slf.jbody(pl)
    # extract a short hint of the reply text (field name may vary)
    reply = ''
    for k in ('reply', 'text', 'message', 'response'):
        if isinstance(d.get(k), str):
            reply = d[k]
            break
    if not reply and isinstance(d.get('messages'), list) and d['messages']:
        m0 = d['messages'][0]
        reply = m0.get('text') or ''
    print(f'{tag}: HTTP {st} dur={ms:.1f}s reply={reply[:60]!r}')
print('RAG_LATENCY_DONE')
