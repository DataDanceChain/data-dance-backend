"""Optional isolated smoke, using a locally cached Node image and no network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

from test_summarize import event
from summarize import clock


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, text=True, capture_output=True, timeout=20,
                          **kwargs).stdout.strip()


def next_report(path, previous=None, trigger=None):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if path.exists():
            current = json.loads(path.read_text())
            if (not previous or previous['asOf'] < current['asOf']) and (
                    trigger is None or current['trigger'] == trigger):
                return current
        time.sleep(.1)
    raise RuntimeError('monitor report was unavailable')


def main():
    name = 'ddc-wallet-monitor-smoke-' + uuid.uuid4().hex[:12]
    image = os.getenv('DDC_JOURNEY_SMOKE_IMAGE', 'node:22-alpine')
    source = None
    monitor = None
    try:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, 'latest.json')
            stream = Path(temp, 'monitor.log')
            def run_collector():
                return docker('run', '-d', '--pull=never', '--network=none', '--log-driver=json-file',
                              '--name=' + name, image, 'node', '-e', 'setInterval(()=>{},60000)')

            def emit(*events):
                raw = json.dumps({'event': 'wallet_journey_timing', 'events': events}) + '\n'
                docker('exec', '-i', source, 'sh', '-c', 'cat > /proc/1/fd/1', input=raw)

            def run_monitor():
                with stream.open('a') as log:
                    return subprocess.Popen([sys.executable, str(Path(__file__).with_name('summarize.py')),
                                             '--container', name, '--output', str(path),
                                             '--threshold', '2', '--timeout-seconds', '4', '--poll-seconds', '1'],
                                            stdout=log, stderr=log, start_new_session=True)

            def stop_monitor(proc):
                import signal
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=5)

            source = run_collector()
            monitor = run_monitor()
            initial = next_report(path, trigger='attach')
            assert initial['source']['containerId'] == source and initial['rows'] == []
            t = clock() - 500
            emit(event(1, 'login_action', t), event(1, 'wallet_ready', t+50),
                 event(2, 'login_action', t), event(2, 'wallet_ready', t+100),
                 event(2, 'wallet_ready', t+100))
            batch = next_report(path, initial, 'count')
            assert batch['settledSincePrevious'] == 2 and batch['rows'][0]['outcomes']['success'] == 2
            assert batch['rows'][0]['spans']['login_action→wallet_ready']['p95Ms'] == 100
            stop_monitor(monitor)
            monitor = run_monitor()
            timer = next_report(path, batch, 'interval')
            assert timer['settledSincePrevious'] == 0 and timer['rows'][0]['outcomes']['success'] == 2
            stop_monitor(monitor)
            docker('rm', '-f', source)
            source = None
            source = run_collector()
            monitor = run_monitor()
            changed = next_report(path, timer, 'attach')
            assert changed['source']['changedSincePrevious'] and changed['source']['containerId'] == source
            assert changed['source']['retentionCoverage'] == 'unverified' and changed['rows'] == []
            assert changed['planetAssetReady'] == 'not_observed'
            assert event(1, 'login_action', t)['flow'] not in stream.read_text()
            print('PASS actual Docker history/follow, 2 unique settlements, timeout after restart, and replacement coverage')
    finally:
        if monitor:
            stop_monitor(monitor)
        if source:
            docker('rm', '-f', source)


if __name__ == '__main__':
    main()
