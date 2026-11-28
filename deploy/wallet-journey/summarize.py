#!/usr/bin/env python3
"""Aggregate only the anonymous Wallet journey records from one Docker log stream."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time


WINDOW = 30 * 60_000
WAIT = 20 * 60_000
MAX_FLOWS = 20_000
MAX_EVENTS = 50_000
MAX_LINE = 16_384
FLOW = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
RELEASE = re.compile(r'[0-9a-f]{40}')
RELEASE_LABEL = re.compile(r'[0-9a-f]{7,40}')
PLATFORMS = {'web', 'ios', 'android'}
CHANNELS = {'google', 'apple', 'x', 'email_otp', 'web3auth_email', 'other', 'unknown'}
VISIBILITY = {'visible', 'hidden', 'unknown'}
REQUIRED = {'flow', 'platform', 'stage', 'at'}
OPTIONAL = {'channel', 'visibility', 'release'}
LOGIN = (
    ('login_start', 'login_action'), ('login_action', 'provider_start'),
    ('login_action', 'provider_return'), ('provider_start', 'provider_return'),
    ('otp_send_start', 'otp_send_done'), ('otp_verify_start', 'otp_verify_done'),
    ('provider_return', 'login_account_request_start'),
    ('login_account_request_start', 'login_account_response'),
    ('login_account_response', 'account_ready'),
    ('provider_return', 'account_ready'), ('account_ready', 'wallet_ready'),
    ('login_action', 'wallet_ready'), ('login_start', 'wallet_ready'),
    ('login_action', 'login_redirect_done'), ('login_action', 'login_failed'),
    ('login_action', 'login_cancelled'), ('login_action', 'login_timeout'),
)
PLANET = (
    ('open_tap', 'popup_reserved'), ('open_tap', 'ticket_ready'),
    ('ticket_ready', 'launch_requested'), ('launch_requested', 'handoff_navigation'),
    ('handoff_navigation', 'handoff_response'), ('handoff_response', 'handoff_script_fetch'),
    ('handoff_script_fetch', 'handoff_script_loaded'), ('handoff_script_loaded', 'handoff_ready'),
    ('handoff_response', 'handoff_ready'), ('handoff_ready', 'exchange_start'),
    ('exchange_start', 'exchange_done'), ('open_tap', 'exchange_done'), ('open_tap', 'open_failed'),
)
TERMINALS = {
    'login': {'wallet_ready': 'success', 'login_failed': 'failed',
              'login_cancelled': 'cancelled', 'login_timeout': 'timedOut',
              'login_redirect_done': 'redirectSuccess', 'login_incomplete': 'incomplete'},
    'planetHandoff': {'exchange_done': 'success', 'open_failed': 'failed'},
}
STAGES = ({p for pair in LOGIN + PLANET for p in pair} |
          set(TERMINALS['login']) | set(TERMINALS['planetHandoff']) | {'login_backgrounded'})
OUTCOMES = ('success', 'redirectSuccess', 'failed', 'cancelled', 'timedOut', 'incomplete', 'pending', 'invalid')


def clock():
    return time.time_ns() // 1_000_000


def date(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds')


def parse_date(value):
    # Docker uses nanoseconds. Python 3.9/3.10 require a 3- or 6-digit
    # fraction in fromisoformat(), so normalize before parsing.
    value = re.sub(r'\.(\d+)(?=Z|[+-])', lambda m: '.' + m[1].ljust(6, '0')[:6], value)
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError
    return (parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)) // (datetime.resolution * 1000)


def dist(values, missing, invalid):
    values.sort()
    def percentile(p):
        return values[math.ceil(len(values) * p) - 1] if values else None
    return {'samples': len(values), 'missingEnd': missing, 'invalid': invalid,
            'p50Ms': percentile(.5), 'p95Ms': percentile(.95), 'maxMs': percentile(1)}


class Journeys:
    def __init__(self, releases):
        self.flows = {}
        self.releases = releases
        self.first_log = None
        self.invalid_rows = 0
        self.dropped = 0
        self.event_slots = 0

    def evidence(self, line, as_of):
        stamp, _, raw = line.partition(b' ')
        try:
            received = parse_date(stamp.decode('ascii'))
        except (ValueError, OverflowError, OSError):
            return
        if received < as_of - WINDOW or received > as_of + 2_000:
            return
        if self.first_log is None or received < self.first_log:
            self.first_log = received
        if b'wallet_journey_timing' not in raw:
            return
        try:
            row = json.loads(raw)
            if not isinstance(row, dict) or row.get('event', row.get('message')) != 'wallet_journey_timing':
                return
            events = row.get('events')
            if not isinstance(events, list) or not 1 <= len(events) <= 12:
                raise ValueError
        except (ValueError, RecursionError):
            self.invalid_rows += 1
            return
        for event in events:
            self.event(event, received)

    def event(self, e, received):
        if not (isinstance(e, dict) and REQUIRED <= e.keys() <= REQUIRED | OPTIONAL and
                isinstance(e['flow'], str) and FLOW.fullmatch(e['flow']) and
                isinstance(e['stage'], str) and e['stage'] in STAGES and
                isinstance(e['platform'], str) and e['platform'] in PLATFORMS and
                type(e['at']) is int and received - WAIT <= e['at'] <= received + 120_000 and
                all(isinstance(e[k], str) and e[k] in allowed for k, allowed in
                    [('channel', CHANNELS), ('visibility', VISIBILITY)] if k in e) and
                ('release' not in e or isinstance(e['release'], str) and RELEASE_LABEL.fullmatch(e['release']))):
            self.invalid_rows += 1
            return
        flow = e['flow']
        stage = e['stage']
        if stage not in self.flows.get(flow, {}) and (self.event_slots >= MAX_EVENTS or
                (flow not in self.flows and len(self.flows) >= MAX_FLOWS)):
            self.dropped += 1
            return
        record = self.flows.setdefault(flow, {})
        raw_release = e.get('release')
        matches = [release for release in self.releases if raw_release and release.startswith(raw_release)]
        release = matches[0] if len(matches) == 1 else 'unrecognized' if raw_release else 'unknown'
        value = (e['at'], e['platform'], e.get('channel', 'unknown'), e.get('visibility', 'unknown'), release)
        previous = record.get(stage)
        if previous is None:
            record[stage] = (value, received, False)
            self.event_slots += 1
        else:
            old, first_received, ambiguous = previous
            # Replay and out-of-order backfill retain the first observation time.
            record[stage] = (old, min(received, first_received), ambiguous or value != old)

    def prune(self, since):
        for flow, events in list(self.flows.items()):
            if all(received < since for _, received, _ in events.values()):
                self.event_slots -= len(events)
                del self.flows[flow]

    def reduce(self, now, previous_at=None):
        since = now - WINDOW
        self.prune(since)
        groups = defaultdict(lambda: {'started': 0, 'outcomes': Counter(), 'spans': defaultdict(
            lambda: {'values': [], 'missing': 0, 'invalid': 0}), 'coldOnly': 0})
        fresh = 0
        for events in self.flows.values():
            if 'open_tap' in events and ('login_start' in events or 'login_action' in events):
                # The browser creates separate anonymous journeys for these intents.
                # Never cross-pair one malformed identifier between them.
                continue
            if 'open_tap' in events:
                kind, started, spans = 'planetHandoff', 'open_tap', PLANET
            elif 'login_action' in events or 'login_start' in events:
                kind, started, spans = 'login', 'login_action' if 'login_action' in events else 'login_start', LOGIN
            else:
                continue
            start, received, ambiguous = events[started]
            if not since <= received <= now:
                continue
            at, platform, channel, visibility, release = start
            # Use the initiating platform even when Android/iOS opens a Web handoff.
            # The first concrete channel on that platform may arrive after login_start.
            related = [x for x, _, duplicate in events.values() if x[1] == platform and not duplicate]
            known_channels = {x[2] for x in related} - {'unknown'}
            known_releases = {x[4] for x in related} - {'unknown'}
            channel = next(iter(known_channels)) if len(known_channels) == 1 else 'unknown'
            release = next(iter(known_releases)) if len(known_releases) == 1 else 'unknown'
            # Default to unknown if no lifecycle observation was made. Treat an
            # observed background even after a visible start as its own cohort.
            visibilities = {x[3] for x, _, duplicate in events.values() if not duplicate}
            visibility = ('hidden' if 'hidden' in visibilities or 'login_backgrounded' in events else
                          'visible' if 'visible' in visibilities else 'unknown')
            g = groups[kind, platform, channel, release, visibility]
            g['started'] += 1
            g['coldOnly'] += started == 'login_start'
            finals = [(stage, events[stage]) for stage in TERMINALS[kind] if stage in events]
            terminal_at = None
            settled = None
            if ambiguous or len(finals) > 1 or len(known_channels) > 1 or len(known_releases) > 1:
                outcome = 'invalid'
            elif finals:
                stage, (end, settled, uncertain) = finals[0]
                terminal_at = end[0]
                outcome = ('invalid' if uncertain or not 0 <= terminal_at - at <= WAIT else
                           TERMINALS[kind][stage])
            elif now >= received + WAIT:
                outcome, settled = 'incomplete', received + WAIT
            else:
                outcome = 'pending'
            g['outcomes'][outcome] += 1
            if settled is not None and previous_at is not None and previous_at < settled <= now and outcome != 'invalid':
                fresh += 1
            if outcome == 'invalid':
                continue
            for a, b in spans:
                if a not in events:
                    continue
                metric = g['spans'][a + '→' + b]
                if b not in events:
                    metric['missing'] += 1
                    continue
                left, _, left_uncertain = events[a]
                right, _, right_uncertain = events[b]
                if (left_uncertain or right_uncertain or not 0 <= right[0] - left[0] <= WAIT
                        or (terminal_at is not None and right[0] > terminal_at)):
                    metric['invalid'] += 1
                    continue
                metric['values'].append(right[0] - left[0])
        rows = []
        for (kind, platform, channel, release, visibility), g in sorted(groups.items()):
            rows.append({'journey': kind, 'platform': platform, 'channel': channel, 'release': release,
                         'visibility': visibility, 'started': g['started'], 'coldOnly': g['coldOnly'],
                         'outcomes': {state: g['outcomes'][state] for state in OUTCOMES},
                         'spans': {span: dist(x['values'], x['missing'], x['invalid'])
                                   for span, x in sorted(g['spans'].items())}})
        return rows, fresh


class Lines:
    def __init__(self):
        self.remainder = b''
        self.discarding = False

    def feed(self, chunk):
        parts = chunk.split(b'\n')
        for part in parts[:-1]:
            if not self.discarding and len(self.remainder) + len(part) <= MAX_LINE:
                yield self.remainder + part
            self.remainder = b''
            self.discarding = False
        tail = parts[-1]
        if not self.discarding and len(self.remainder) + len(tail) <= MAX_LINE:
            self.remainder += tail
        else:
            self.remainder = b''
            self.discarding = True


def publish(path, result):
    payload = json.dumps(result, separators=(',', ':'), allow_nan=False)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.latest-',
                                     dir=path.parent, delete=False) as fp:
        temp = Path(fp.name)
        try:
            fp.write(payload + '\n')
            fp.flush()
            os.fsync(fp.fileno())
            temp.replace(path)
            directory = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temp.unlink(missing_ok=True)
    for row in result['rows']:
        print(json.dumps({'event': 'ddc_wallet_journey_cohort', 'asOf': result['asOf'], **row},
                         separators=(',', ':')), flush=True)
    print(json.dumps({'event': 'ddc_wallet_journey_report', 'cohorts': len(result['rows']),
                      **{k: v for k, v in result.items() if k != 'rows'}},
                     separators=(',', ':')), flush=True)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(3)
        except subprocess.TimeoutExpired:
            process.kill()


def source_info(container):
    info = subprocess.check_output(
        ['docker', 'inspect', '--format', '{{.Id}} {{.Created}} {{.State.Running}}', container],
        stderr=subprocess.DEVNULL, timeout=10, text=True).split()
    if len(info) != 3 or not re.fullmatch('[a-f0-9]{64}', info[0]) or info[2] != 'true':
        raise RuntimeError('collector_not_running')
    return info[0], parse_date(info[1])


def monitor(container, report, threshold, timeout, poll, releases):
    source, created_at = source_info(container)
    previous = json.loads(report.read_text()) if report.exists() else None
    previous_at = parse_date(previous['asOf']) if previous else None
    previous_source = previous['source']['containerId'] if previous else None
    state = Journeys(releases)
    cut = clock()
    requested = cut - WINDOW
    args = ['docker', 'logs', '--timestamps']
    # Bound history to the rolling window. Read once on attach; the second
    # command follows live from the same boundary. Inclusive replay is harmless.
    with subprocess.Popen(args + ['--since', date(requested), '--until', date(cut), source],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
        try:
            lines = Lines()
            deadline = time.monotonic() + 60
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.select(max(0, deadline - time.monotonic())) and time.monotonic() < deadline:
                    chunk = os.read(process.stdout.fileno(), 65_536)
                    if not chunk:
                        break
                    for line in lines.feed(chunk):
                        state.evidence(line, clock())
                else:
                    raise RuntimeError('collector_history_read_timed_out')
            if process.wait(5):
                raise RuntimeError('collector_history_read_failed')
        finally:
            stop(process)
    with subprocess.Popen(args + ['--since', date(cut), '--follow', source],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
        try:
            lines = Lines()
            next_check = 0
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    ready = selector.select(max(0, next_check - time.monotonic()))
                    if ready:
                        chunk = os.read(process.stdout.fileno(), 65_536)
                        if not chunk:
                            raise RuntimeError('collector_log_stream_ended')
                        now = clock()
                        for line in lines.feed(chunk):
                            state.evidence(line, now)
                    if (mono := time.monotonic()) < next_check:
                        continue
                    next_check = mono + poll
                    if process.poll() is not None:
                        raise RuntimeError('collector_log_stream_ended')
                    now = clock()
                    rows, fresh = state.reduce(now, previous_at)
                    changed = previous_source is not None and previous_source != source
                    due = ('attach' if previous_at is None or changed else
                           'count' if fresh >= threshold else
                           'interval' if now - previous_at >= timeout * 1000 else None)
                    if not due:
                        continue
                    if source_info(container)[0] != source:
                        raise RuntimeError('collector_replaced')
                    publish(report, {'schemaVersion': 1, 'asOf': date(now), 'windowStart': date(now - WINDOW),
                                     'trigger': due, 'settledSincePrevious': fresh if not changed else None,
                                     'source': {'containerId': source, 'createdAt': date(created_at),
                                                'changedSincePrevious': changed,
                                                'requestedFromOnAttach': date(requested),
                                                'firstLogOnAttachOrLive': date(state.first_log) if state.first_log else None,
                                                'retentionCoverage': 'unverified'},
                                     'input': {'invalidEventsOrRowsSinceAttach': state.invalid_rows,
                                               'droppedAtCapacitySinceAttach': state.dropped},
                                     'rows': rows, 'planetAssetReady': 'not_observed'})
                    previous_at, previous_source = now, source
        finally:
            stop(process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', default='ddc-journey-collector-v85')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--threshold', type=int, default=20)
    parser.add_argument('--timeout-seconds', type=int, default=300)
    parser.add_argument('--poll-seconds', type=int, default=15)
    args = parser.parse_args()
    releases = set(os.getenv('DDC_JOURNEY_RELEASES', '').split())
    if (not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]*', args.container) or
            min(args.threshold, args.timeout_seconds, args.poll_seconds) < 1 or
            args.poll_seconds > args.timeout_seconds or
            len(releases) > 32 or any(not RELEASE.fullmatch(s) for s in releases)):
        parser.error('invalid monitor settings')
    try:
        monitor(args.container, args.output, args.threshold, args.timeout_seconds, args.poll_seconds, releases)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, RuntimeError):
        # A subprocess error can carry its raw output. Do not write it to the
        # report or journal. An unsuccessful service exit is itself monitored.
        raise SystemExit('wallet journey monitor stopped: collector stream or report unavailable')


if __name__ == '__main__':
    main()
