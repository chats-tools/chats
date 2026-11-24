"""Checks last_said_ms, the Python copy of the rule in chats-panel/hooks/said.ts.

Run from the repo root: python3 chatsbar/test_said.py
Same made-up lines as chats-panel/tests/said.test.tsx.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chats  # noqa: E402

LAST = '2026-01-01T11:39:04.421Z'
QUIET = '\n'.join([
    '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-01-01T11:38:47.417Z"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":"%s"}' % LAST,
    '{"type":"system","subtype":"stop_hook_summary","timestamp":"2026-01-01T11:39:04.437Z"}',
    '{"type":"queue-operation","timestamp":"2026-01-01T15:00:00.000Z"}',
    '{"type":"frame-link","timestamp":"2026-01-01T15:00:00.100Z"}',
    '{"type":"bridge-session"}',
    '',
])


def said(text):
    with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False) as fh:
        fh.write(text)
    try:
        return chats.last_said_ms(fh.name)
    finally:
        os.unlink(fh.name)


def main():
    assert said(QUIET) == chats.stamp_ms(LAST), 'the last message is the time'
    assert said('{"type":"mode"}\n{"type":"custom-title"}') == 0, 'no message gives 0'
    assert chats.last_said_ms('/no/such/file.jsonl') == 0, 'a missing file gives 0'
    print('test_said: 3 checks pass')


if __name__ == '__main__':
    main()
