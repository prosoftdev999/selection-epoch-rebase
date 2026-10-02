import json
from pathlib import Path

from oracle import replay_file as replay_legacy
from rebase_oracle import replay_file as replay_rebase

ARTIFACT = Path('/app/editor_audit.json')

legacy_rows = replay_legacy('/tests/data/capture.jsonl')['checkpoints']
for row in legacy_rows:
    rev = row.pop('applied_remote_rev')
    row['remote_clock'] = {'text': rev, 'tree': 0}
    row['pending_local'] = []
EXPECTED = {'checkpoints': legacy_rows + replay_rebase('/tests/data/rebase_capture.jsonl')['checkpoints']}
EXPECTED_KEYS = {
    'checkpoint_id',
    'blocks',
    'anchor',
    'focus',
    'direction',
    'selected_text',
    'remote_clock',
    'pending_local',
}


def load_candidate():
    assert ARTIFACT.is_file(), 'missing /app/editor_audit.json'
    with ARTIFACT.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def test_schema_and_checkpoint_count():
    candidate = load_candidate()
    assert set(candidate) == {'checkpoints'}
    checkpoints = candidate['checkpoints']
    assert isinstance(checkpoints, list)
    assert len(checkpoints) == len(EXPECTED['checkpoints'])
    for row in checkpoints:
        assert isinstance(row, dict)
        assert set(row) == EXPECTED_KEYS
        assert isinstance(row['checkpoint_id'], str)
        assert isinstance(row['blocks'], list)
        for block in row['blocks']:
            assert set(block) == {'block_id', 'text'}
            assert isinstance(block['block_id'], str)
            assert isinstance(block['text'], str)
        for key in ('anchor', 'focus'):
            point = row[key]
            if point is not None:
                assert set(point) == {'block_id', 'utf16', 'affinity'}
                assert isinstance(point['block_id'], str)
                assert isinstance(point['utf16'], int) and point['utf16'] >= 0
                assert point['affinity'] in {'forward', 'backward'}
        assert row['direction'] in {'forward', 'backward', 'none'}
        assert isinstance(row['selected_text'], str)
        clock = row['remote_clock']
        assert isinstance(clock, dict) and set(clock) == {'text', 'tree'}
        assert all(isinstance(clock[k], int) and clock[k] >= 0 for k in ('text', 'tree'))
        assert isinstance(row['pending_local'], list)
        assert all(isinstance(x, str) for x in row['pending_local'])


def test_checkpoint_ids_clocks_and_pending_local():
    candidate = load_candidate()['checkpoints']
    expected = EXPECTED['checkpoints']
    assert [(r['checkpoint_id'], r['remote_clock'], r['pending_local']) for r in candidate] == [
        (r['checkpoint_id'], r['remote_clock'], r['pending_local']) for r in expected
    ]


def test_ordered_block_snapshots():
    candidate = load_candidate()['checkpoints']
    expected = EXPECTED['checkpoints']
    assert [r['blocks'] for r in candidate] == [r['blocks'] for r in expected]


def test_selection_endpoints_and_direction():
    candidate = load_candidate()['checkpoints']
    expected = EXPECTED['checkpoints']
    assert [(r['anchor'], r['focus'], r['direction']) for r in candidate] == [
        (r['anchor'], r['focus'], r['direction']) for r in expected
    ]


def test_selected_text():
    candidate = load_candidate()['checkpoints']
    expected = EXPECTED['checkpoints']
    assert [r['selected_text'] for r in candidate] == [r['selected_text'] for r in expected]
