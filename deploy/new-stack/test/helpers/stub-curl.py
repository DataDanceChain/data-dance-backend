#!/usr/bin/env python3
# stub-curl.py: a stand-in for curl in the 30-nginx.sh / 99-teardown.sh tests of run-local-tests.sh (sections 12, 12b)
# and test/helpers/takeover-signals.sh. It answers the way the host nginx and this stack's two containers would, from
# files and variables of the test:
#   http://127.0.0.1:$STUB_API_PORT/...    this stack's api: $STUB_API_CODE (401) JSON on /partner/tge/me while
#                                          $STUB_DIR/stack-up exists, otherwise nothing listens (prints 000, exit 7)
#   http://127.0.0.1:$STUB_WEB_PORT/...    this stack's web: /ddc-build.json is the tge build marker for
#                                          https://$STUB_API_HOST/api ($STUB_MARKER_API overrides the API URL in it)
#   Host: <a host of $OUR_HOSTS>           through the host nginx: this stack (as above; 502 while it is down) when that
#                                          host's file in $NGINX_AVAIL starts with the ddcnew marker line (502 when
#                                          STUB_VIA_NGINX_BROKEN=1), and then also the vhost token of that file at
#                                          /.well-known/ddcnew-vhost-token; the other party's stack when another file
#                                          is there (200; with STUB_OTHER_STACK=1 it answers like a stack: 401 JSON on
#                                          /partner/tge/me, the same build marker); 404 when there is none.
#                                          STUB_NGINX_STALE=1: nginx still serves the other party's vhost whatever the
#                                          files say (a configuration that was not reloaded), answering like a stack.
#   https                                  the virtual server is chosen by the SNI name (--resolve <name>:..., or the
#                                          URL's host name), never by a Host header. STUB_TLS_HANG=1: nothing answers
#                                          https (a listener that never completes TLS): with -m/--max-time the stub
#                                          stops at once like curl's timeout (000, exit 28), without one it hangs.
#   any other Host                         200; after a reload ($STUB_DIR/reloaded), $CHANGE_HOST answers 502 over http
#                                          and $CHANGE_TLS_HOST over https
# Understands -H 'Host: x', -w '%{http_code}' / '%{content_type}', -o /dev/null, -m, --resolve host:port:addr, URLs.
import os
import re
import sys
import time
from urllib.parse import urlsplit

args = sys.argv[1:]
host = url = fmt = out = resolve = maxtime = None
i = 0
while i < len(args):
    a = args[i]
    if a in ('-H', '-w', '-o', '-m', '--max-time', '--resolve') and i + 1 < len(args):
        v = args[i + 1]
        if a == '-H' and v.lower().startswith('host:'):
            host = v.split(':', 1)[1].strip()
        elif a == '-w':
            fmt = v
        elif a == '-o':
            out = v
        elif a in ('-m', '--max-time'):
            maxtime = v
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
TOKEN_PATH = '/.well-known/ddcnew-vhost-token'


def nothing(code_exit):
    if fmt:
        sys.stdout.write(fmt.replace('%{http_code}', '000').replace('%{content_type}', ''))
    sys.exit(code_exit)


def api(path):
    if not stack_up:
        return None
    if path.startswith('/partner/tge/me'):
        return (int(os.environ.get('STUB_API_CODE', '401')), 'application/json; charset=utf-8', '{"error":"unauthorized","error_description":"stub"}')
    return (404, 'application/json; charset=utf-8', '{}')


def web(path):
    if not stack_up:
        return None
    if path == '/ddc-build.json':
        return (200, 'application/json', marker)
    return (200, 'text/html', '<!doctype html><title>stub</title>')


def other_stack(path, is_api):
    # the other party's rehearsal stack: the same code as this one, so the same 401 and the same build marker
    if path == TOKEN_PATH:
        return (404, 'text/html', 'not found')
    if is_api:
        if path.startswith('/partner/tge/me'):
            return (401, 'application/json; charset=utf-8', '{"error":"unauthorized","error_description":"other"}')
        return (404, 'application/json; charset=utf-8', '{}')
    if path == '/ddc-build.json':
        return (200, 'application/json', marker)
    return (200, 'text/html', '<!doctype html><title>other</title>')


def vhost_token(f):
    try:
        m = re.search(r'return 200 "([0-9a-f]{32})";', open(f).read())
    except OSError:
        return None
    return m.group(1) if m else None


if u.scheme == 'https' and os.environ.get('STUB_TLS_HANG') == '1':
    if maxtime is None:
        time.sleep(float(os.environ.get('STUB_TLS_HANG_SECS', '600')))
    nothing(28)

res = None
port = str(u.port or (443 if u.scheme == 'https' else 80))
if u.hostname == '127.0.0.1' and port == os.environ.get('STUB_API_PORT', '10020') and not host:
    res = api(u.path)
elif u.hostname == '127.0.0.1' and port == os.environ.get('STUB_WEB_PORT', '9021') and not host:
    res = web(u.path)
else:
    if u.scheme == 'https':
        h = resolve.split(':')[0] if resolve else u.hostname   # SNI only
    else:
        h = host or u.hostname
    ours = os.environ.get('OUR_HOSTS', '').split()
    if h in ours:
        f = os.path.join(os.environ.get('NGINX_AVAIL', '/nonexistent'), h)
        if os.environ.get('STUB_NGINX_STALE') == '1':
            res = other_stack(u.path, h == ours[0])
        elif os.path.isfile(f) and open(f).readline().startswith('# ddcnew-vhost:'):
            if u.path == TOKEN_PATH:
                t = vhost_token(f)
                res = (200, 'text/plain', t) if t else (404, 'text/html', 'not found')
            else:
                res = (api if h == ours[0] else web)(u.path) or (502, 'text/html', 'bad gateway')
            if os.environ.get('STUB_VIA_NGINX_BROKEN') == '1':   # the host nginx routes it wrong, the stack itself is fine
                res = (502, 'text/html', 'bad gateway')
        elif os.path.exists(f):
            res = other_stack(u.path, h == ours[0]) if os.environ.get('STUB_OTHER_STACK') == '1' else (200, 'text/html', 'the other party')
        else:
            res = (404, 'text/html', 'no such vhost')
    else:
        change = os.environ.get('CHANGE_TLS_HOST' if u.scheme == 'https' else 'CHANGE_HOST', 'none')
        res = (502, 'text/html', 'bad gateway') if (reloaded and h == change) else (200, 'text/html', 'ok')

if res is None:
    nothing(7)
code, ctype, body = res
if out != '/dev/null':
    sys.stdout.write(body)
if fmt:
    sys.stdout.write(fmt.replace('%{http_code}', str(code)).replace('%{content_type}', ctype))
