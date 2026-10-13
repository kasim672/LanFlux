import test from 'node:test';
import assert from 'node:assert/strict';
import {invitedRoom} from '../lanflux/static/invitation.js';

test('invitation query identifies the precise normalized room and no query stays manual', () => {
  assert.equal(invitedRoom(''),null);
  assert.equal(invitedRoom('?other=value'),null);
  assert.equal(invitedRoom('?room=ABCD2345EFGH6789'),'ABCD2345EFGH6789');
  assert.equal(invitedRoom('?room=abcd-2345-efgh-6789'),'ABCD2345EFGH6789');
});

test('invalid, empty, duplicate and script-like room query parameters are rejected', () => {
  for (const value of ['?room=','?room=short','?room='+'A'.repeat(17),'?room=IIII0000OOOO1111','?room=%3Cscript%3Ealert(1)%3C/script%3E','?room=ABCD2345EFGH6789&room=ABCD2345EFGH6789']) {
    assert.throws(() => invitedRoom(value),/invitation.*room codes?/i);
  }
});
