import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOREBOARD_URL } from '../src/nfl.js';
import { fakeFetch, loggedInApp } from './helpers.js';

const team = (name: string, location: string, abbreviation: string) => ({ name, location, displayName: `${location} ${name}`, shortDisplayName: name, abbreviation });
const event = (id: string, away: ReturnType<typeof team>, home: ReturnType<typeof team>, state: string, networks: string[], date = '2026-10-11T17:00Z') => ({
  id,
  date,
  name: `${away.displayName} at ${home.displayName}`,
  shortName: `${away.abbreviation} @ ${home.abbreviation}`,
  status: { type: { state, shortDetail: state === 'in' ? '2nd 5:12' : '1:00 PM' } },
  competitions: [
    {
      competitors: [
        { homeAway: 'home', team: home },
        { homeAway: 'away', team: away },
      ],
      broadcasts: [{ market: 'national', names: networks }],
    },
  ],
});

const scoreboard = {
  events: [
    event('1', team('Bears', 'Chicago', 'CHI'), team('Packers', 'Green Bay', 'GB'), 'in', ['FOX']),
    event('2', team('Chiefs', 'Kansas City', 'KC'), team('Bills', 'Buffalo', 'BUF'), 'in', ['CBS']),
    event('3', team('Jets', 'New York', 'NYJ'), team('Patriots', 'New England', 'NE'), 'in', ['CBS']),
    event('4', team('Rams', 'Los Angeles', 'LAR'), team('49ers', 'San Francisco', 'SF'), 'pre', ['NBC'], '2026-10-12T00:20Z'),
    event('5', team('Saints', 'New Orleans', 'NO'), team('Falcons', 'Atlanta', 'ATL'), 'in', ['FOX']),
    event('6', team('Lions', 'Detroit', 'DET'), team('Vikings', 'Minnesota', 'MIN'), 'post', ['Prime Video']),
  ],
};

const playlist = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="News",FOX News',
  'http://x/foxnews.m3u8',
  '#EXTINF:-1 group-title="USA",USA | FOX HD',
  'http://x/fox.m3u8',
  '#EXTINF:-1 group-title="USA",CBS Sports Network',
  'http://x/cbssn.m3u8',
  '#EXTINF:-1 group-title="USA",CBS',
  'http://x/cbs.m3u8',
  '#EXTINF:-1 group-title="NFL",NFL 01: Chicago Bears vs Green Bay Packers',
  'http://x/nfl01.m3u8',
  '#EXTINF:-1 group-title="NFL",NFL 02 | KC @ BUF',
  'http://x/nfl02.m3u8',
  '#EXTINF:-1 group-title="NFL",NFL 03 | No Event',
  'http://x/nfl03.m3u8',
  '#EXTINF:-1 group-title="Movies",Atlanta Movie Channel',
  'http://x/atl.m3u8',
].join('\n');

test('NFL preset matches games to event channels first, then network channels', async () => {
  const { fn, calls } = fakeFetch({ [SCOREBOARD_URL]: scoreboard });
  const { call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_file', name: 'IPTV', fileContent: playlist });

  const res = await call('GET', '/api/presets/nfl');
  assert.equal(res.statusCode, 200, res.body);
  const games = res.json().games as { id: string; state: string; channel: { name: string } | null; matchedBy: string | null }[];
  const summary = games.map((g) => [g.id, g.state, g.channel?.name ?? null, g.matchedBy]);
  assert.deepEqual(summary, [
    ['1', 'in', 'NFL 01: Chicago Bears vs Green Bay Packers', 'teams'],
    ['2', 'in', 'NFL 02 | KC @ BUF', 'teams'],
    ['3', 'in', 'CBS', 'network'], // not "CBS Sports Network"
    ['5', 'in', 'USA | FOX HD', 'network'], // not "FOX News"; "Atlanta Movie Channel" alone is not a match
    ['4', 'pre', null, null], // no NBC channel in this list
    ['6', 'post', null, null],
  ]);

  // Cached for a minute: a second call does not hit ESPN again.
  await call('GET', '/api/presets/nfl');
  assert.equal(calls.filter((c) => c.url === SCOREBOARD_URL).length, 1);
});

test('NFL preset reports a schedule outage', async () => {
  const { fn } = fakeFetch({});
  const { call } = await loggedInApp({ fetch: fn });
  const res = await call('GET', '/api/presets/nfl');
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /NFL schedule is unavailable/);
});

test('NFL preset re-pulls stale playlists so game-day channel names are current', async () => {
  let names = 'NFL 01 | No Event';
  const { fn, calls } = fakeFetch({
    [SCOREBOARD_URL]: scoreboard,
    'http://provider/list.m3u': () => `#EXTM3U\n#EXTINF:-1,${names}\nhttp://x/nfl01.m3u8\n`,
  });
  const { app, call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_url', name: 'P', url: 'http://provider/list.m3u' });

  names = 'NFL 01 | Bears vs Packers';
  // Fresh playlist: no re-pull.
  let games = (await call('GET', '/api/presets/nfl')).json().games;
  assert.equal(games[0].channel, null);
  assert.equal(calls.filter((c) => c.url === 'http://provider/list.m3u').length, 1);

  // Four hours later the playlist is stale and gets re-pulled before matching.
  const db = (app as unknown as { sources: { db: import('node:sqlite').DatabaseSync } }).sources.db;
  db.prepare(`UPDATE sources SET last_refreshed_at = datetime('now', '-4 hours')`).run();
  games = (await call('GET', '/api/presets/nfl')).json().games;
  assert.equal(games[0].channel.name, 'NFL 01 | Bears vs Packers');
  assert.equal(calls.filter((c) => c.url === 'http://provider/list.m3u').length, 2);
});

test('college basketball preset matches schools by name and college networks', async () => {
  const school = (name: string, location: string, abbreviation: string) => ({ name, location, displayName: `${location} ${name}`, shortDisplayName: location, abbreviation });
  const games = {
    events: [
      event('11', school('Blue Devils', 'Duke', 'DUKE'), school('Tar Heels', 'North Carolina', 'UNC'), 'in', ['ESPN']),
      event('12', school('Wildcats', 'Kentucky', 'UK'), school('Jayhawks', 'Kansas', 'KU'), 'in', ['ESPN']),
      event('13', school('Spartans', 'Michigan State', 'MSU'), school('Hoosiers', 'Indiana', 'IU'), 'in', ['BTN']),
      event('14', school('Bulldogs', 'Gonzaga', 'GONZ'), school('Gaels', "Saint Mary's", 'SMC'), 'pre', ['ESPN+']),
    ],
  };
  const list = [
    '#EXTM3U',
    '#EXTINF:-1,NCAAB 01: Duke vs North Carolina',
    'http://x/ev1.m3u8',
    '#EXTINF:-1,US: ESPN HD',
    'http://x/espn.m3u8',
    '#EXTINF:-1,US: ESPNU',
    'http://x/espnu.m3u8',
    '#EXTINF:-1,US: Big Ten Network',
    'http://x/btn.m3u8',
  ].join('\n');
  const { fn } = fakeFetch({ 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard': games });
  const { call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_file', name: 'P', fileContent: list });
  const res = await call('GET', '/api/presets/ncaab');
  assert.equal(res.statusCode, 200, res.body);
  const byId = Object.fromEntries(res.json().games.map((g: { id: string; channel: { name: string } | null; matchedBy: string | null }) => [g.id, g]));
  assert.equal(byId['11'].channel.name, 'NCAAB 01: Duke vs North Carolina');
  assert.equal(byId['11'].matchedBy, 'teams');
  assert.equal(byId['12'].channel.name, 'US: ESPN HD', 'ESPN, not ESPNU');
  assert.equal(byId['13'].channel.name, 'US: Big Ten Network');
  assert.equal(byId['14'].channel, null, 'ESPN+ has no channel');
  assert.equal((await call('GET', '/api/presets/nhl-nope')).statusCode, 404);
});
