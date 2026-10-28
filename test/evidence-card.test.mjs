import test from 'node:test';
import assert from 'node:assert/strict';
import { demoCard, evidenceCard } from '../src/card.mjs';
import { createLiveTally } from '../src/live-tally.mjs';
import { createBoard } from '../src/engine.mjs';

const BASE = Date.parse('2026-10-27T10:00:00.000Z');
const event = (id, userId, text, timestamp = BASE) => ({ id, userId, text, timestamp });

test('live evidence card offers two NASA inspection paths while preserving the simulator source contract', () => {
  const value = createLiveTally({ now: () => BASE }).state(false);
  assert.equal(value.card.claim, 'The Moon is slowly moving away from Earth.');
  assert.deepEqual(value.card.sources.map((source) => source.url), [
    'https://science.nasa.gov/moon/facts/',
    'https://www.jpl.nasa.gov/news/the-apollo-experiment-that-keeps-on-giving/'
  ]);
  assert.equal(value.card.source.url, value.card.sources[0].url);
  assert.match(value.card.prompt, /inspect first/);
  assert.deepEqual(value.sourceReviews, [{ sourceNumber: 1, status: 'pending' }, { sourceNumber: 2, status: 'pending' }]);
  const simulator = createBoard({ card: demoCard, now: () => BASE }).getState();
  assert.equal(simulator.card.source.url, demoCard.source.url);
  assert.deepEqual(simulator.card.choices, demoCard.choices);
  assert.equal('sources' in simulator.card, false);
  assert.notDeepEqual(evidenceCard.choices, demoCard.choices);
});

test('source review is a manual host mark, independent of aggregate votes and poll rounds', () => {
  let time = BASE;
  const tally = createLiveTally({ now: () => time });
  tally.open(1000);
  tally.accept(event('vote1', 'private-viewer-1', '!vote a'), true);
  tally.accept(event('vote2', 'private-viewer-2', '!vote b'), true);
  assert.equal(tally.state(true).sourceReviews[0].status, 'pending');
  assert.deepEqual(tally.markSource(1, 'viewed'), { ok: true, code: 'source_marked', sourceNumber: 1, status: 'viewed' });
  assert.deepEqual(tally.state(true).vote.counts, { a: 1, b: 1 });
  assert.deepEqual(tally.state(false).sourceReviews, [{ sourceNumber: 1, status: 'viewed' }, { sourceNumber: 2, status: 'pending' }]);
  time += 1000;
  tally.open(1000);
  assert.equal(tally.state(false).sourceReviews[0].status, 'viewed');
  assert.equal(tally.state(false).vote.total, 0);
  tally.reset();
  assert.deepEqual(tally.state(false).sourceReviews, [{ sourceNumber: 1, status: 'pending' }, { sourceNumber: 2, status: 'pending' }]);
});

test('invalid marks do not change reviews, and public snapshots contain no viewer data or writable internal state', () => {
  const tally = createLiveTally({ now: () => BASE });
  tally.open();
  tally.accept(event('private-message-id', 'private-viewer-id', '!source'), true);
  tally.markSource(2, 'viewed');
  for (const args of [[0, 'viewed'], [3, 'viewed'], [1.5, 'viewed'], ['1', 'viewed'], [1, 'verified']]) {
    assert.equal(tally.markSource(...args).code, 'invalid_source_review');
  }
  const view = tally.state(true);
  assert.doesNotMatch(JSON.stringify(view), /private-message-id|private-viewer-id/);
  view.sourceReviews[0].status = 'viewed';
  view.card.sources[0].url = 'https://example.org/changed';
  const later = tally.state(true);
  assert.deepEqual(later.sourceReviews, [{ sourceNumber: 1, status: 'pending' }, { sourceNumber: 2, status: 'viewed' }]);
  assert.equal(later.card.source.url, 'https://science.nasa.gov/moon/facts/');
});
