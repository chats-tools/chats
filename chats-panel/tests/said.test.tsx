import { expect, test } from 'claude-code/testing'

import { lastSaidIn, shownTime } from '../hooks/said'

// A Code chat's time is its last user or assistant line, not the app's lastActivityAt.
// The end of a quiet chat's transcript: its last answer, then lines with no work (made up).
const LAST = '2026-01-01T11:39:04.421Z'
const QUIET = [
  '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-01-01T11:38:47.417Z"}',
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":"${LAST}"}`,
  '{"type":"system","subtype":"stop_hook_summary","timestamp":"2026-01-01T11:39:04.437Z"}',
  '{"type":"queue-operation","timestamp":"2026-01-01T15:00:00.000Z"}',
  '{"type":"frame-link","timestamp":"2026-01-01T15:00:00.100Z"}',
  '{"type":"bridge-session"}',
  '',
].join('\n')

test('the last message is the time, not later lines with no work', () => {
  expect(lastSaidIn(QUIET)).toBe(Date.parse(LAST))
})

test('a line cut at the start of the read is skipped', () => {
  expect(lastSaidIn('ser","timestamp":"2026-01-01T09:00:00.000Z"}\n{"type":"mode"}')).toBe(0)
})

test('no message gives 0', () => {
  expect(lastSaidIn('{"type":"mode"}\n{"type":"custom-title"}')).toBe(0)
})

test('the shown time', () => {
  // Quiet chat: the last message, even when the app time is later.
  expect(shownTime(100, 900, false)).toBe(100)
  // No transcript: the app time.
  expect(shownTime(0, 900, false)).toBe(900)
  // A working chat keeps the later time.
  expect(shownTime(100, 900, true)).toBe(900)
  expect(shownTime(950, 900, true)).toBe(950)
})
