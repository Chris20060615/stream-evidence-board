// Educational source-navigation example; not a study or a measure of learning.
export const demoCard = {
  id: 'moon-distance-01',
  claim: 'The Moon is slowly moving away from Earth.',
  prompt: 'Where would you start checking this claim?',
  choices: { a: 'The original measurement or agency source', b: 'A short clip repeating the claim' },
  source: {
    title: 'Moon Facts',
    publisher: 'NASA Science',
    url: 'https://science.nasa.gov/moon/facts/',
    note: 'Open the source, find the distance section, and check what supports the statement. This poll captures a preference; it does not measure understanding.'
  }
};

// Official NASA pages read on 2026-10-27. These are two source pages from
// the same agency, not independent experiments or an automatic fact check.
// Keep demoCard unchanged for the existing simulator and its source contract.
const overviewSource = Object.freeze({
  ...demoCard.source,
  note: 'Read the Size and Distance section for NASA\'s overview of the Moon moving away from Earth.'
});
const measurementSource = Object.freeze({
  title: 'The Apollo Experiment That Keeps on Giving',
  publisher: 'NASA JPL',
  url: 'https://www.jpl.nasa.gov/news/the-apollo-experiment-that-keeps-on-giving/',
  note: 'Inspect the laser-reflector timing method. This JPL article reports an Earth–Moon distance increase of 3.8 cm per year.'
});

export const evidenceCard = Object.freeze({
  ...demoCard,
  id: 'moon-distance-evidence-01',
  prompt: 'Which NASA source should we inspect first?',
  choices: Object.freeze({
    a: 'Overview: Moon Facts',
    b: 'Measurement: lunar laser ranging'
  }),
  source: overviewSource,
  sources: Object.freeze([overviewSource, measurementSource])
});
