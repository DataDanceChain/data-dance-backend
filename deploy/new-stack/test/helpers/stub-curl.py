#!/usr/bin/env python3
# stub-curl.py: a stand-in for curl in the 30-nginx.sh / 99-teardown.sh tests of run-local-tests.sh (sections 12, 12b).
# It answers the way the host nginx and this stack's two containers would, from files and variables of the test:
#   http://127.0.0.1:$STUB_API_PORT/...    this stack's api: 401 JSON on /partner/tge/me while $STUB_DIR/stack-up exists,
#                                          otherwise nothing listens (prints 000, exit 7, like curl)
#   http://127.0.0.1:$STUB_WEB_PORT/...    this stack's web: /ddc-build.json is the tge build marker for
#                                          https://$STUB_API_HOST/api ($STUB_MARKER_API overrides the API URL in it)
#   Host: <a host of $OUR_HOSTS>           through the host nginx: this stack (as above; 502 while it is down) when that
#                                          host's file in $NGINX_AVAIL starts with the ddcnew marker line (502 when
#                                          STUB_VIA_NGINX_BROKEN=1), the other
#                                          party's stack (200) when another file is there, 404 when there is none
#   any other Host                         200; after a reload ($STUB_DIR/reloaded), $CHANGE_HOST answers 502 over http
#                                          and $CHANGE_TLS_HOST over https
# Understands -H 'Host: x', -w '%{http_code}' / '%{content_type}', -o /dev/null, --resolve host:port:addr, http(s) URLs.
import os
import sys
from urllib.parse import urlsplit

args = sys.argv[1:]
host = url = fmt = out = resolve = None
i = 0
while i < len(args):
    a = args[i]
    if a in ('-H', '-w', '-o', '-m', '--resolve') and i + 1 < len(args):
        v = args[i + 1]
        if a == '-H' and v.lower().startswith('host:'):
            host = v.split(':', 1)[1].strip()
        elif a == '-w':
            fmt = v
        elif a == '-o':
            out = v
        elif a == '--resolve':
            resolve = v
        i += 2
        continue
    if a.startswith('http://') or a.startswith('https://'):
        url = a
    i += 1

u = urlsplit(url or 'http://127.0.0.1/')
sd = os.environ.get('STUB_DIR', '/nonexistent')
reloaded = os.path.exists(os.path.join(sd, 'reloaded'))
stack_up = os.path.exists(os.path.join(sd, 'stack-up'))
api_host = os.environ.get('STUB_API_HOST', 'api-rehearsal.datadance.ai')
marker_api = os.environ.get('STUB_MARKER_API', 'https://%s/api' % api_host)
marker = ('{"mode":"tge","apiEnv":"tge","apiBaseUrl":"%s","w3aNetwork":"sapphire_mainnet",'
          '"w3aClientId":"BBpkxUTUr-stub-client-id","chainId":44508}' % marker_api)


def api(path):
    if not stack_up:
        return None
    if path.startswith('/partner/tge/me'):
        return (401, 'application/json; charset=utf-8', '{"error":"unauthorized","error_description":"stub"}')
    return (404, 'application/json; charset=utf-8', '{}')


def web(path):
    if not stack_up:
        return None
    if path == '/ddc-build.json':
        return (200, 'application/json', marker)
    return (200, 'text/html', '<!doctype html><title>stub</title>')


res = None
port = str(u.port or (443 if u.scheme == 'https' else 80))
if u.hostname == '127.0.0.1' and port == os.environ.get('STUB_API_PORT', '10020') and not host:
    res = api(u.path)
elif u.hostname == '127.0.0.1' and port == os.environ.get('STUB_WEB_PORT', '9021') and not host:
    res = web(u.path)
else:
    h = host or (resolve.split(':')[0] if resolve else u.hostname)
    ours = os.environ.get('OUR_HOSTS', '').split()
    if h in ours:
        f = os.path.join(os.environ.get('NGINX_AVAIL', '/nonexistent'), h)
        if os.path.isfile(f) and open(f).readline().startswith('# ddcnew-vhost:'):
            res = (api if h == ours[0] else web)(u.path) or (502, 'text/html', 'bad gateway')
            if os.environ.get('STUB_VIA_NGINX_BROKEN') == '1':   # the host nginx routes it wrong, the stack itself is fine
                res = (502, 'text/html', 'bad gateway')
        elif os.path.exists(f):
            res = (200, 'text/html', 'the other party')
        else:
            res = (404, 'text/html', 'no such vhost')
    else:
        change = os.environ.get('CHANGE_TLS_HOST' if u.scheme == 'https' else 'CHANGE_HOST', 'none')
        res = (502, 'text/html', 'bad gateway') if (reloaded and h == change) else (200, 'text/html', 'ok')

if res is None:
    if fmt:
        sys.stdout.write(fmt.replace('%{http_code}', '000').replace('%{content_type}', ''))
    sys.exit(7)
code, ctype, body = res
if out != '/dev/null':
    sys.stdout.write(body)
if fmt:
    sys.stdout.write(fmt.replace('%{http_code}', str(code)).replace('%{content_type}', ctype))
