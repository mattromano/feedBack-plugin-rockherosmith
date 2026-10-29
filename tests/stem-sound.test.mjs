// Part audio per stem (Plan 3 Decision 10): a pure state machine, nothing plays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStemSound, FULL_MIX, isUnsplit } from '../src/stem-sound.js';

const ctl = (id, stemId, mode = 'rockband') => ({ id, stemId, controller: true, mode });
const real = (id, stemId) => ({ id, stemId, controller: false });

test('a controller miss drops its stem; the next hit by any controller on it restores', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', 'bass')] });
    assert.deepEqual(s.stems(), ['bass']);
    assert.equal(s.muted('bass'), false);
    assert.deepEqual(s.judge('ctl1', 'miss'), ['bass']);
    assert.equal(s.muted('bass'), true);
    assert.deepEqual(s.judge('ctl1', 'miss'), [], 'already dropped');
    assert.deepEqual(s.judge('ctl1', 'sustain-end'), [], 'not a judgment that moves the stem');
    assert.deepEqual(s.judge('ctl2', 'hit'), ['bass'], "the other controller's hit brings it back");
    assert.equal(s.muted('bass'), false);
    assert.deepEqual(s.judge('ctl2', 'hit'), []);
});

test('a bass miss never touches the guitar stem', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', 'guitar')] });
    assert.deepEqual(s.judge('ctl1', 'miss'), ['bass']);
    assert.equal(s.muted('guitar'), false);
    assert.deepEqual(s.judge('ctl2', 'hit'), [], "a hit on the guitar stem doesn't bring the bass back");
    assert.equal(s.muted('bass'), true);
});

test('Lead and Rhythm on one guitar stem share it', () => {
    // A song with no rhythm stem: Rhythm plays the guitar stem too.
    const s = createStemSound({ members: [ctl('ctl1', 'guitar'), ctl('ctl2', 'guitar')] });
    assert.deepEqual(s.stems(), ['guitar']);
    assert.deepEqual(s.judge('ctl2', 'miss'), ['guitar']);
    assert.deepEqual(s.judge('ctl1', 'hit'), ['guitar']);
    assert.equal(s.muted('guitar'), false);
});

test('an Always play controller keeps the stem', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass', 'always')] });
    assert.deepEqual(s.judge('ctl1', 'miss'), []);
    const shared = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', 'bass', 'always')] });
    assert.deepEqual(shared.judge('ctl1', 'miss'), [], "the Always play controller's audio stays");
    assert.equal(shared.muted('bass'), false);
});

test('a real part on the stem keeps it through controller misses', () => {
    const s = createStemSound({ members: [real('guitar', 'guitar'), ctl('ctl1', 'guitar')] });
    assert.deepEqual(s.judge('ctl1', 'miss'), []);
    assert.deepEqual(s.judge('ctl1', 'overstrum'), []);
    assert.equal(s.muted('guitar'), false);
    assert.deepEqual(s.judge('guitar', 'miss'), [], "a real part's judgments never move a stem");
});

test('overstrum drops like a miss', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass')] });
    assert.deepEqual(s.judge('ctl1', 'overstrum'), ['bass']);
    assert.equal(s.muted('bass'), true);
    assert.deepEqual(s.judge('ctl1', 'hit'), ['bass']);
});

test("a failed controller's stem mutes unless another active player is on it; rescue unmutes", () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass', 'always'), ctl('ctl2', 'guitar'), real('guitar', 'guitar')] });
    assert.deepEqual(s.setFailed(['ctl1']), ['bass'], 'an Always play controller mutes on fail too');
    assert.equal(s.muted('bass'), true);
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2']), [], 'the guitarist still plays the guitar stem');
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2', 'guitar']), ['guitar'], 'everyone on it is out, one a controller');
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2', 'guitar']), [], 'no change, nothing sent');
    assert.deepEqual(s.setFailed(['guitar']).sort(), ['bass', 'guitar'], 'rescue unmutes');
    assert.equal(s.muted('bass'), false);
    // Real parts alone keep their own fail claims: the stem sound never mutes for them.
    const realOnly = createStemSound({ members: [real('guitar', 'guitar')] });
    assert.deepEqual(realOnly.setFailed(['guitar']), []);
    // A rescued controller's dropped stem comes back with it.
    const rb = createStemSound({ members: [ctl('ctl1', 'bass')] });
    rb.judge('ctl1', 'miss');
    assert.deepEqual(rb.setFailed(['ctl1']), [], 'muted already');
    assert.deepEqual(rb.setFailed([]), ['bass']);
    assert.equal(rb.muted('bass'), false);
});

test("failed players' judgments are ignored", () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', 'bass')] });
    s.setFailed(['ctl1']);
    assert.deepEqual(s.judge('ctl1', 'miss'), []);
    assert.equal(s.muted('bass'), false, 'ctl2 still plays it');
    s.judge('ctl2', 'miss');
    assert.equal(s.muted('bass'), true);
    assert.deepEqual(s.judge('ctl1', 'hit'), [], "a failed player's hit brings nothing back");
    assert.equal(s.muted('bass'), true);
});

test('seek restores', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', 'guitar')] });
    s.judge('ctl1', 'miss');
    s.judge('ctl2', 'overstrum');
    assert.deepEqual(s.seek().sort(), ['bass', 'guitar']);
    assert.equal(s.muted('bass'), false);
    assert.deepEqual(s.seek(), []);
    // A seek never brings back a stem every player on has failed out of.
    s.setFailed(['ctl1']);
    assert.deepEqual(s.seek(), []);
    assert.equal(s.muted('bass'), true);
});

test('no stem: nothing changes', () => {
    const s = createStemSound({ members: [ctl('ctl1', null), ctl('ctl2', undefined)] });
    assert.deepEqual(s.stems(), []);
    assert.deepEqual(s.judge('ctl1', 'miss'), []);
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2']), []);
    assert.deepEqual(s.seek(), []);
    assert.equal(s.muted('bass'), false);
    assert.deepEqual(createStemSound({}).stems(), []);
    assert.deepEqual(createStemSound({ members: [ctl('ctl1', 'bass')] }).judge('nobody', 'miss'), []);
});

// ---- Plan 6 Task B7: drum sound modes for controller drummers (Decision 14, Ruling 9) ----

test('all-kit controllers: muted from the start, judgments ignored, seek keeps it muted', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'drums', 'kit'), ctl('ctl2', 'drums', 'kit')] });
    assert.deepEqual(s.stems(), ['drums']);
    assert.equal(s.muted('drums'), true, 'My kit only: the stem is muted all song');
    assert.deepEqual(s.judge('ctl1', 'hit'), [], "a hit doesn't bring it back");
    assert.deepEqual(s.judge('ctl2', 'miss'), []);
    assert.deepEqual(s.judge('ctl2', 'overhit'), []);
    assert.equal(s.muted('drums'), true);
    assert.deepEqual(s.seek(), [], 'seek keeps it muted');
    assert.equal(s.muted('drums'), true);
    // The fail rules are unchanged: out and rescued, it stays muted.
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2']), []);
    assert.deepEqual(s.setFailed([]), []);
    assert.equal(s.muted('drums'), true);
});

test('rockband and kit controllers share drop-outs', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'drums', 'rockband'), ctl('ctl2', 'drums', 'kit')] });
    assert.equal(s.muted('drums'), false, 'not every member is on My kit only');
    assert.deepEqual(s.judge('ctl2', 'miss'), ['drums'], "the kit player's miss drops it");
    assert.deepEqual(s.judge('ctl1', 'hit'), ['drums'], "the Rock Band player's hit brings it back");
    assert.deepEqual(s.judge('ctl1', 'overhit'), ['drums'], 'an overhit drops like a miss');
    assert.deepEqual(s.judge('ctl2', 'hit'), ['drums'], "the kit player's hit brings it back too");
    s.judge('ctl2', 'overhit');
    assert.deepEqual(s.seek(), ['drums'], 'seek restores');
    assert.equal(s.muted('drums'), false);
    // Failed players' judgments still never move it.
    s.setFailed(['ctl2']);
    assert.deepEqual(s.judge('ctl2', 'miss'), []);
    assert.deepEqual(s.judge('ctl1', 'miss'), ['drums']);
});

test('a Song drums controller keeps the stem', () => {
    const rb = createStemSound({ members: [ctl('ctl1', 'drums', 'rockband'), ctl('ctl2', 'drums', 'always')] });
    assert.deepEqual(rb.judge('ctl1', 'miss'), []);
    assert.deepEqual(rb.judge('ctl2', 'overhit'), []);
    assert.equal(rb.muted('drums'), false);
    const kit = createStemSound({ members: [ctl('ctl1', 'drums', 'kit'), ctl('ctl2', 'drums', 'always')] });
    assert.equal(kit.muted('drums'), false, "My kit only beside a Song drummer doesn't mute the stem");
    assert.deepEqual(kit.judge('ctl1', 'miss'), []);
    assert.equal(kit.muted('drums'), false);
});

test('a real drummer on the drums stem: stem-sound does nothing to it (no kit mute, no drops, no fail mute)', () => {
    const s = createStemSound({ members: [real('drums', 'drums'), ctl('ctl1', 'drums', 'kit'), ctl('ctl2', 'drums', 'rockband')] });
    assert.equal(s.muted('drums'), false, 'no kit mute');
    assert.deepEqual(s.judge('ctl1', 'miss'), []);
    assert.deepEqual(s.judge('ctl2', 'overhit'), []);
    assert.deepEqual(s.judge('drums', 'miss'), []);
    assert.equal(s.muted('drums'), false, 'no drops');
    assert.deepEqual(s.setFailed(['ctl1', 'ctl2']), []);
    assert.deepEqual(s.setFailed(['drums', 'ctl1', 'ctl2']), [], "the real drummer's own fail claim mutes it, not this");
    assert.equal(s.muted('drums'), false, 'no fail mute');
    assert.deepEqual(s.seek(), []);
    // Only the drums stem: a real guitarist beside a failed 5-fret controller keeps Plan 3's fail rule.
    const g = createStemSound({ members: [real('drums', 'drums'), real('guitar', 'guitar'), ctl('ctl3', 'guitar')] });
    assert.deepEqual(g.setFailed(['guitar', 'ctl3', 'drums']), ['guitar']);
});

// ---- The full mix: unsplit songs (no stems, or only `full`) ----

test('isUnsplit: no stems or only full', () => {
    assert.equal(isUnsplit([]), true);
    assert.equal(isUnsplit(['full']), true);
    assert.equal(isUnsplit(null), true);
    assert.equal(isUnsplit(['full', 'guitar']), false);
    assert.equal(isUnsplit(['guitar', 'drums']), false);
});

test('unsplit song: a controller with no stem drops the full mix; a hit or a seek brings it back', () => {
    const s = createStemSound({ members: [ctl('ctl1', null)], fullMix: true });
    assert.deepEqual(s.stems(), [FULL_MIX]);
    assert.equal(s.muted(FULL_MIX), false);
    assert.deepEqual(s.judge('ctl1', 'miss'), [FULL_MIX]);
    assert.equal(s.muted(FULL_MIX), true);
    assert.deepEqual(s.judge('ctl1', 'overstrum'), [], 'already dropped');
    assert.deepEqual(s.judge('ctl1', 'hit'), [FULL_MIX]);
    assert.deepEqual(s.judge('ctl1', 'overhit'), [FULL_MIX], 'an overhit drops it too');
    assert.deepEqual(s.seek(), [FULL_MIX]);
    assert.equal(s.muted(FULL_MIX), false);
});

test('the full mix keeps the stem rules: a real part or an Always play controller on it keeps the song', () => {
    const withReal = createStemSound({ members: [real('guitar', null), ctl('ctl1', null)], fullMix: true });
    assert.deepEqual(withReal.judge('ctl1', 'miss'), []);
    assert.equal(withReal.muted(FULL_MIX), false);
    const withAlways = createStemSound({ members: [ctl('ctl1', null), ctl('ctl2', null, 'always')], fullMix: true });
    assert.deepEqual(withAlways.judge('ctl1', 'miss'), []);
    // Fail and rescue move it like a stem, and a rescue clears the drop-out.
    const f = createStemSound({ members: [ctl('ctl1', null)], fullMix: true });
    f.judge('ctl1', 'miss');
    assert.deepEqual(f.setFailed(['ctl1']), []);
    assert.deepEqual(f.setFailed([]), [FULL_MIX]);
    assert.equal(f.muted(FULL_MIX), false);
});

test('My kit only plays as Song drums on the full mix: never muted all song, never dropped', () => {
    const s = createStemSound({ members: [ctl('ctl1', null, 'kit')], fullMix: true });
    assert.equal(s.muted(FULL_MIX), false);
    assert.deepEqual(s.judge('ctl1', 'overhit'), []);
    const shared = createStemSound({ members: [ctl('ctl1', null, 'kit'), ctl('ctl2', null)], fullMix: true });
    assert.deepEqual(shared.judge('ctl2', 'miss'), [], 'the kit player keeps the mix, like an Always play controller');
});

test('players with their own stem stay on it; without fullMix a stemless player is ignored as before', () => {
    const s = createStemSound({ members: [ctl('ctl1', 'bass'), ctl('ctl2', null)], fullMix: true });
    assert.deepEqual(s.stems().sort(), [FULL_MIX, 'bass'].sort());
    assert.deepEqual(s.judge('ctl1', 'miss'), ['bass'], "the bass player's miss leaves the mix alone");
    assert.deepEqual(s.judge('ctl2', 'miss'), [FULL_MIX]);
    const split = createStemSound({ members: [ctl('ctl1', null)] });
    assert.deepEqual(split.stems(), []);
    assert.deepEqual(split.judge('ctl1', 'miss'), []);
});

// Play layer contract §6: the real drummer in Rock Band on a song with no drum stem
// muffles the full mix like a Rock Band controller (a `dropout` member).
test('a real drummer in Rock Band with no drum stem drops the full mix out', () => {
    const drummer = { id: 'drums', stemId: null, controller: false, dropout: true, mode: 'rockband' };
    const s = createStemSound({ members: [drummer], fullMix: true });
    assert.deepEqual(s.stems(), [FULL_MIX]);
    assert.deepEqual(s.judge('drums', 'miss'), [FULL_MIX]);
    assert.equal(s.muted(FULL_MIX), true);
    assert.deepEqual(s.judge('drums', 'hit'), [FULL_MIX]);
    assert.deepEqual(s.judge('drums', 'overhit'), [FULL_MIX]);
    assert.deepEqual(s.seek(), [FULL_MIX]);
    // Its own fail never mutes the mix (only controllers' fail claims do).
    assert.deepEqual(s.setFailed(['drums']), []);
    // A guitar part on the mix keeps it playing.
    const band = createStemSound({ members: [drummer, { id: 'guitar', stemId: null, controller: false }], fullMix: true });
    assert.deepEqual(band.judge('drums', 'miss'), []);
    // Song + pads keeps the mix; a drummer with its own stem is left to drum-sound.
    const song = createStemSound({ members: [{ ...drummer, mode: 'song' }], fullMix: true });
    assert.deepEqual(song.judge('drums', 'miss'), []);
    const own = createStemSound({ members: [{ ...drummer, stemId: 'drums' }] });
    assert.deepEqual(own.stems(), []);
});
