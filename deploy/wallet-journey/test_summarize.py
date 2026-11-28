import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from summarize import Journeys, Lines, MAX_LINE, WAIT, date, parse_date


T = 1_800_000_000_000
RELEASE = '0123456789abcdef' * 2 + '01234567'
UNKNOWN_RELEASE = 'a' * 40


def flow(n):
    return f'b7bfeaf4-cdf0-4fd7-b627-{n:012x}'


def event(n, stage, at=None, **meta):
    return {'stage': stage, 'flow': flow(n), 'platform': 'web', 'at': T if at is None else at,
            **meta}


def ingest(state, *events, received=None, key='event'):
    received = T if received is None else received
    # A Docker RFC3339 log timestamp precedes Winston or dedicated collector JSON.
    raw = json.dumps({key: 'wallet_journey_timing', 'events': events})
    state.evidence((date(received) + ' ' + raw).encode(), received)


class Tests(unittest.TestCase):
    def test_docker_nanosecond_timestamp(self):
        self.assertEqual(parse_date('1970-01-01T00:00:00.123456789Z'), 123)
        self.assertEqual(parse_date('1970-01-01T08:00:00.001234567+08:00'), 1)

    def test_by_flow_and_dimensions_dedup_reverse_order(self):
        state = Journeys({RELEASE})
        a = event(1, 'wallet_ready', T + 70, channel='google', visibility='visible', release=RELEASE[:12])
        ingest(state, a, event(2, 'wallet_ready', T + 230), received=T + 240)
        ingest(state, event(1, 'login_action', T + 20, channel='google', release=RELEASE),
               event(3, 'login_action', channel='google', release=RELEASE, visibility='visible'),
               key='message')
        ingest(state, a, event(3, 'wallet_ready', T + 150), received=T + 300)
        rows, fresh = state.reduce(T + 300, T + 10)
        row, = rows
        self.assertEqual(row['outcomes']['success'], 2)
        self.assertEqual(row['channel'], 'google')
        self.assertEqual(row['visibility'], 'visible')
        self.assertEqual(row['release'], RELEASE)
        self.assertEqual(row['spans']['login_action→wallet_ready'],
                         {'samples': 2, 'missingEnd': 0, 'invalid': 0, 'p50Ms': 50, 'p95Ms': 150, 'maxMs': 150})
        self.assertEqual(fresh, 2)
        self.assertEqual(state.reduce(T + 301, T + 300)[1], 0)

    def test_classifies_explicit_outcomes_and_ages_pending(self):
        state = Journeys(set())
        outcomes = ['wallet_ready', 'login_failed', 'login_cancelled', 'login_timeout', 'login_redirect_done',
                    'login_incomplete']
        ingest(state, *(event(i, 'login_action') for i in range(1, 8)))
        ingest(state, *(event(i, stage, T+50) for i, stage in enumerate(outcomes, 1)), received=T+50)
        row, = state.reduce(T + 1_000)[0]
        self.assertEqual(row['outcomes'], dict(success=1, redirectSuccess=1, failed=1, cancelled=1,
                                               timedOut=1, incomplete=1, pending=1, invalid=0))
        self.assertEqual(row['spans']['login_action→wallet_ready']['samples'], 1)
        self.assertEqual(row['spans']['login_action→login_redirect_done']['samples'], 1)
        rows, fresh = state.reduce(T+WAIT, T+WAIT-1)
        self.assertEqual(rows[0]['outcomes']['incomplete'], 2)
        self.assertEqual(rows[0]['outcomes']['pending'], 0)
        self.assertEqual(fresh, 1)

    def test_planet_uses_initiating_platform_and_no_asset_ready_claim(self):
        state = Journeys({RELEASE})
        ingest(state, event(1, 'open_tap', platform='ios', release=RELEASE),
               event(1, 'exchange_done', T+90, release=UNKNOWN_RELEASE))
        row, = state.reduce(T+100)[0]
        self.assertEqual((row['journey'], row['platform'], row['release']), ('planetHandoff', 'ios', RELEASE))
        self.assertEqual(row['spans']['open_tap→exchange_done']['p95Ms'], 90)

    def test_untrustworthy_input_never_leaks(self):
        state = Journeys({RELEASE})
        ingest(state, event(1, 'login_action', release=UNKNOWN_RELEASE),
               event(1, 'wallet_ready', password='fixture-secret'),
               event(2, 'login_action', release='fixture-secret'),
               event(3, 'login_action', platform=['admin']),
               event(4, 'login_action', at=True),
               event(1, 'login_backgrounded', T+10))
        rows, _ = state.reduce(T+15)
        text = json.dumps(rows)
        for value in [flow(1), str(T), UNKNOWN_RELEASE, 'fixture-secret', 'password']:
            self.assertNotIn(value, text)
        self.assertEqual(state.invalid_rows, 4)
        row, = rows
        self.assertEqual(row['release'], 'unrecognized')
        self.assertEqual(row['visibility'], 'hidden')

    def test_conflicting_results_and_bad_time_do_not_count_as_success(self):
        state = Journeys(set())
        ingest(state, event(1, 'login_action'), event(1, 'wallet_ready', T+100),
               event(1, 'wallet_ready', T+110), event(2, 'login_action'),
               event(2, 'login_failed', T+100), event(2, 'wallet_ready', T+110),
               event(3, 'open_tap'), event(3, 'exchange_done', T-1),
               event(4, 'open_tap'), event(4, 'login_action'), event(4, 'wallet_ready'))
        rows, _ = state.reduce(T+150)
        self.assertEqual(sum(r['outcomes']['invalid'] for r in rows), 3)
        self.assertEqual(sum(r['outcomes']['success'] for r in rows), 0)

    def test_chunking_and_bounded_oversized_line(self):
        lines = Lines()
        self.assertEqual(list(lines.feed(b'par')), [])
        self.assertEqual(list(lines.feed(b'tial\nnext\nstart')), [b'partial', b'next'])
        self.assertEqual(list(lines.feed(b'x'*MAX_LINE)), [])
        self.assertEqual(list(lines.feed(b'end\nvalid\n')), [b'valid'])

    def test_cli_rejects_invalid_source_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp, 'missing', 'latest.json')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('summarize.py')),
                                     '--container', 'invalid*fixture', '--output', str(target)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid monitor settings', result.stderr)
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
