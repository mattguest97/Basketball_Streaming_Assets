const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);
const teamsFile = path.join(__dirname, 'teams.json');
const playHqGraphqlUrl = 'https://api.euprod.playhq.com/graphql';
const playHqSpectatorUrl = 'https://spectator.euprod.playhq.com/graphql';
const playHqQuery = `
  query LiveGame($gameId: ID!) {
    discoverGame(gameID: $gameId) {
      id
      home { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      result { home { score } away { score } }
      statistics {
        home { players { playerNumber player { ... on DiscoverParticipant { profile { firstName lastName } } ... on DiscoverParticipantFillInPlayer { profile { firstName lastName } } ... on DiscoverGamePermitFillInPlayer { profile { firstName lastName } } ... on DiscoverRegularFillInPlayer { name } ... on DiscoverAnonymousParticipant { name } } statistics { count type { value shortName label } } periodStatistics { type statistics { type { value label shortName advanced } count details { value } } } } }
        away { players { playerNumber player { ... on DiscoverParticipant { profile { firstName lastName } } ... on DiscoverParticipantFillInPlayer { profile { firstName lastName } } ... on DiscoverGamePermitFillInPlayer { profile { firstName lastName } } ... on DiscoverRegularFillInPlayer { name } ... on DiscoverAnonymousParticipant { name } } statistics { count type { value shortName label } } periodStatistics { type statistics { type { value label shortName advanced } count details { value } } } } }
      }
    }
  }`;
const playHqClockQuery = 'query LiveClock($gameId: ID!) { game(id: $gameId) { clock { period periodValue status time lastUpdatedAt } } }';
let liveFeedTimer = null;
let liveFeedConfig = { url: '', enabled: false, useScore: false, useTime: false, pollSeconds: 10, lastUpdated: null, error: '' };

function syncLiveFeedState() {
  state.liveFeed = { ...liveFeedConfig };
}

function readTeams() {
  try {
    const data = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
    return Array.isArray(data.teams) ? data.teams.map((team) => ({
      ...team,
      players: Array.isArray(team.players) ? team.players.filter((player) => !isPrivatePlayerName(player.name)) : []
    })) : [];
  } catch (error) {
    return [];
  }
}

function writeTeams(teams) {
  fs.writeFileSync(teamsFile, JSON.stringify({ teams }, null, 2) + '\n', 'utf8');
}

function teamIdFor(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
}

function isPrivatePlayerName(name) {
  return /private\s+player|anonymous\s+player/i.test(String(name || '').trim());
}

function normaliseTeam(team) {
  const name = String(team.name || '').trim().slice(0, 80);
  const shortName = String(team.shortName || '').trim().slice(0, 40);
  const color = String(team.color || '').trim();
  const logo = typeof team.logo === 'string' ? team.logo.slice(0, 700000) : '';
  const players = Array.isArray(team.players) ? team.players.slice(0, 15).map((player) => ({
    number: String(player.number || '').trim().slice(0, 5),
    name: String(player.name || '').trim().slice(0, 80),
    points: Math.max(0, Number(player.points) || 0),
    fouls: Math.max(0, Number(player.fouls) || 0),
    onePoint: Math.max(0, Number(player.onePoint) || 0),
    twoPoint: Math.max(0, Number(player.twoPoint) || 0),
    threePoint: Math.max(0, Number(player.threePoint) || 0)
  })).filter((player) => (player.number || player.name) && !isPrivatePlayerName(player.name)) : [];
  if (!name || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return { id: String(team.id || ''), name, shortName, color, logo, players };
}

function gameIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch (error) {
    return '';
  }
}

function valueForStatistic(statistics, names) {
  const match = (statistics || []).find((statistic) => {
    const type = statistic.type || {};
    return [type.value, type.shortName, type.label].some((value) => names.includes(String(value || '').toUpperCase()));
  });
  return match ? Number(match.count) || 0 : 0;
}

function playerName(player) {
  if (!player) return 'Unknown Player';
  if (player.name) return player.name;
  const profile = player.profile || {};
  return [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Unknown Player';
}

function normaliseLivePlayer(player) {
  const name = playerName(player.player);
  if (isPrivatePlayerName(name)) return null;
  const advanced = {};
  const periodStatistics = (player.periodStatistics || []).flatMap((period) => period.statistics || []);
  const allStatistics = [...(player.statistics || []), ...periodStatistics];
  (player.periodStatistics || []).forEach((period) => {
    (period.statistics || []).forEach((statistic) => {
      const key = statistic.type?.shortName || statistic.type?.label || statistic.type?.value;
      if (key) advanced[key] = Number(statistic.count) || 0;
    });
  });
  return {
    number: String(player.playerNumber || ''),
    name,
    points: Number(player.playerPoints) || valueForStatistic(player.statistics, ['POINTS', 'PTS', 'TOTAL_POINTS', 'TOTAL_SCORE']),
    fouls: valueForStatistic(allStatistics, ['F', 'PF', 'TOTAL_FOULS', 'FOULS', 'FOUL', 'PERSONAL_FOULS', 'PERSONAL FOULS']),
    onePoint: valueForStatistic(allStatistics, ['1_POINT_SCORE', 'ONE_POINT_SCORE']),
    twoPoint: valueForStatistic(allStatistics, ['2_POINT_SCORE', 'TWO_POINT_SCORE']),
    threePoint: valueForStatistic(allStatistics, ['3_POINT_SCORE', 'THREE_POINT_SCORE']),
    advanced
  };
}

function persistLivePlayers(side, players) {
  const teamId = state[side].teamId;
  if (!teamId) return;
  const teams = readTeams();
  const index = teams.findIndex((team) => team.id === teamId);
  if (index < 0) return;
  const nextPlayers = players.slice(0, 15).map((player) => ({
    number: String(player.number || ''),
    name: String(player.name || ''),
    points: Math.max(0, Number(player.points) || 0),
    fouls: Math.max(0, Number(player.fouls) || 0),
    onePoint: Math.max(0, Number(player.onePoint) || 0),
    twoPoint: Math.max(0, Number(player.twoPoint) || 0),
    threePoint: Math.max(0, Number(player.threePoint) || 0)
  })).filter((player) => player.number || player.name);
  if (JSON.stringify(teams[index].players || []) === JSON.stringify(nextPlayers)) return;
  teams[index] = { ...teams[index], players: nextPlayers };
  writeTeams(teams);
}

function teamScore(teamStatistics) {
  return valueForStatistic(teamStatistics?.statisticsV2 || teamStatistics?.statistics, ['POINTS', 'PTS', 'TOTAL_POINTS', 'SCORE']);
}

function secondsFromClock(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function pollPlayHq() {
  const gameId = gameIdFromUrl(liveFeedConfig.url);
  if (!liveFeedConfig.enabled || !gameId) return;
  try {
    const response = await fetch(playHqGraphqlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        tenant: 'basketball-england',
        origin: 'https://www.playhq.com',
        referer: 'https://www.playhq.com/',
        'request-id': crypto.randomUUID(),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.135.0 Chrome/148.0.7778.280 Electron/42.8.1 Safari/537.36'
      },
      body: JSON.stringify({ operationName: 'LiveGame', query: playHqQuery, variables: { gameId } })
    });
    if (!response.ok) throw new Error(`PlayHQ returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors[0].message || 'PlayHQ query failed');
    const game = payload.data?.discoverGame;
    if (!game) throw new Error('PlayHQ returned no game data');

    const liveTeams = {
      home: (game.statistics?.home?.players || []).map(normaliseLivePlayer).filter(Boolean),
      away: (game.statistics?.away?.players || []).map(normaliseLivePlayer).filter(Boolean)
    };
    const liveTeamNames = {
      home: String(game.home?.name || '').trim(),
      away: String(game.away?.name || '').trim()
    };
    for (const side of ['home', 'away']) {
      const players = liveTeams[side];
      if (liveTeamNames[side]) state[side].name = liveTeamNames[side];
      state[side].lineup = players;
      persistLivePlayers(side, players);
    }
    if (liveFeedConfig.useScore) {
      for (const side of ['home', 'away']) {
        const score = Number(game.result?.[side]?.score);
        if (Number.isFinite(score)) state[side].score = score;
      }
    }
    if (liveFeedConfig.useTime) {
      try {
        await updatePlayHqClock(gameId);
      } catch (error) {
        liveFeedConfig.error = `Time unavailable: ${error.message}`;
      }
    }
    state.liveStats = { source: 'playhq', updatedAt: new Date().toISOString(), teamNames: liveTeamNames, home: liveTeams.home, away: liveTeams.away };
    liveFeedConfig.lastUpdated = state.liveStats.updatedAt;
    if (!liveFeedConfig.error.startsWith('Time unavailable:')) liveFeedConfig.error = '';
    syncLiveFeedState();
    io.emit('state', state);
  } catch (error) {
    liveFeedConfig.error = error.message;
    syncLiveFeedState();
    io.emit('state', state);
  }
}

async function updatePlayHqClock(gameId) {
  const response = await fetch(playHqSpectatorUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
      'x-phq-tenant': 'be',
      origin: 'https://www.playhq.com',
      referer: 'https://www.playhq.com/',
      'user-agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({ operationName: 'LiveClock', query: playHqClockQuery, variables: { gameId } })
  });
  if (!response.ok) throw new Error(`PlayHQ clock returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'PlayHQ clock query failed');
  const clock = payload.data?.game?.clock;
  const seconds = secondsFromClock(clock?.time);
  if (seconds !== null) state.clock = seconds;
  if (clock?.periodValue) {
    const period = { FIRST_QTR: 1, SECOND_QTR: 2, THIRD_QTR: 3, FOURTH_QTR: 4 }[clock.periodValue];
    if (period) state.quarter = period;
  }
  state.running = clock?.status === 'RESUME';
}

function configureLiveFeed(url, enabled, useScore, useTime, pollSeconds) {
  const safePollSeconds = Math.max(1, Math.min(300, Number(pollSeconds) || 10));
  liveFeedConfig = {
    ...liveFeedConfig,
    url: String(url || '').trim(),
    enabled: !!enabled,
    useScore: !!useScore,
    useTime: !!useTime,
    pollSeconds: safePollSeconds,
    error: ''
  };
  syncLiveFeedState();
  if (liveFeedTimer) clearInterval(liveFeedTimer);
  liveFeedTimer = liveFeedConfig.enabled ? setInterval(pollPlayHq, safePollSeconds * 1000) : null;
  if (liveFeedConfig.enabled) pollPlayHq();
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

const pageAliases = {
  '/control': 'control.html',
  '/team-entry': 'team-entry.html',
  '/tipoff': 'tipoff.html',
  '/lineup': 'lineup.html',
  '/foul': 'foul.html',
  '/stats': 'stats.html',
  '/player-stats': 'player-stats.html'
};
Object.entries(pageAliases).forEach(([route, file]) => {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
});

app.get('/api/teams', (req, res) => {
  res.json({ teams: readTeams() });
});

app.post('/api/teams', (req, res) => {
  const incoming = normaliseTeam(req.body || {});
  if (!incoming) return res.status(400).json({ ok: false, error: 'Team name and a six-digit hex color are required.' });

  const teams = readTeams();
  const existingIndex = incoming.id ? teams.findIndex((team) => team.id === incoming.id) : -1;
  if (existingIndex >= 0) {
    teams[existingIndex] = incoming;
  } else {
    const baseId = teamIdFor(incoming.name);
    let id = baseId;
    let suffix = 2;
    while (teams.some((team) => team.id === id)) id = `${baseId}-${suffix++}`;
    incoming.id = id;
    teams.push(incoming);
  }
  writeTeams(teams);
  res.json({ ok: true, team: incoming, teams });
});

app.delete('/api/teams/:id', (req, res) => {
  const teams = readTeams();
  const filtered = teams.filter((team) => team.id !== req.params.id);
  if (filtered.length === teams.length) return res.status(404).json({ ok: false, error: 'Team not found.' });
  writeTeams(filtered);
  res.json({ ok: true, teams: filtered });
});

// Simple relay endpoint for FIBA Live Stats or other live feeds.
// POST JSON payloads to /api/fiba and they will be broadcast to connected clients as 'fibaUpdate'.
app.post('/api/fiba', (req, res) => {
  const payload = req.body || {};
  // Optionally validate or transform payload here.
  io.emit('fibaUpdate', payload);
  res.json({ ok: true });
});

// initial game state
let state = {
  home: {
    name: 'Home',
    teamId: '',
    shortName: '',
    logo: '',
    color: '#0052cc',
    score: 0,
    fouls: 0,
    timeoutsRemaining: 2,
    lineup: []
  },
  away: {
    name: 'Away',
    teamId: '',
    shortName: '',
    logo: '',
    color: '#cc0000',
    score: 0,
    fouls: 0,
    timeoutsRemaining: 2,
    lineup: []
  },
  quarter: 1,
  periodLengthsSec: 600, // default 10 minutes
  clock: 600,
  running: false,
  tipoffSeconds: 1800,
  tipoffRunning: false,
  tipoffTitle: 'Time to Tip Off',
  tipoffShowScore: true,
  liveFeed: liveFeedConfig,
  liveStats: null,
  fontFamily: 'Arial, sans-serif',
  bonus: { home: false, away: false }
};

const savedTeamProfiles = readTeams();
for (const [side, profile] of [['home', savedTeamProfiles[0]], ['away', savedTeamProfiles[1]]]) {
  if (!profile) continue;
  state[side].name = profile.name || state[side].name;
  state[side].teamId = profile.id || '';
  state[side].shortName = profile.shortName || '';
  state[side].logo = profile.logo || '';
  state[side].color = profile.color || state[side].color;
  state[side].lineup = Array.isArray(profile.players) ? profile.players : [];
}

let clockTimer = null;

function updateBonusFlags() {
  state.bonus.home = state.home.fouls >= 5;
  state.bonus.away = state.away.fouls >= 5;
}

function tick() {
  let changed = false;
  if (state.running && state.clock > 0) {
    state.clock -= 1;
    changed = true;
  }
  if (state.running && state.clock <= 0) {
    state.running = false;
    changed = true;
  }
  if (state.tipoffRunning && state.tipoffSeconds > 0) {
    state.tipoffSeconds -= 1;
    changed = true;
  }
  if (state.tipoffRunning && state.tipoffSeconds <= 0) {
    state.tipoffRunning = false;
    changed = true;
  }
  if (changed) io.emit('state', state);
}

io.on('connection', (socket) => {
  socket.emit('state', state);

  socket.on('control', (patch) => {
    // apply allowed patches from control panel
    const p = patch || {};
    if (p.home) Object.assign(state.home, p.home);
    if (p.away) Object.assign(state.away, p.away);
    for (const team of ['home', 'away']) {
      if (p.lineup && Array.isArray(p.lineup[team])) {
        state[team].lineup = p.lineup[team].slice(0, 15).map((player) => ({
          number: String(player.number || ''),
          name: String(player.name || ''),
          points: Math.max(0, Number(player.points) || 0),
          fouls: Math.max(0, Number(player.fouls) || 0),
          onePoint: Math.max(0, Number(player.onePoint) || 0),
          twoPoint: Math.max(0, Number(player.twoPoint) || 0),
          threePoint: Math.max(0, Number(player.threePoint) || 0)
        })).filter((player) => player.name || player.number);
      }
    }
    if (typeof p.quarter === 'number') state.quarter = p.quarter;
    if (typeof p.clock === 'number') state.clock = p.clock;
    if (typeof p.running === 'boolean') state.running = p.running;
    if (p.fontFamily) state.fontFamily = p.fontFamily;
    if (typeof p.periodLengthsSec === 'number') state.periodLengthsSec = p.periodLengthsSec;

    // enforce FIBA timeouts per half: first half quarters 1-2 -> 2 each, second half 3-4 -> 3 each when quarter increments to 3
    if (p.resetForQuarter) {
      if (state.quarter === 3) {
        state.home.timeoutsRemaining = 3;
        state.away.timeoutsRemaining = 3;
      }
      if (state.quarter <= 2) {
        state.home.timeoutsRemaining = 2;
        state.away.timeoutsRemaining = 2;
      }
    }

    updateBonusFlags();
    io.emit('state', state);
  });

  socket.on('playHqFeed', ({ url, enabled, useScore, useTime, pollSeconds }) => {
    const gameId = gameIdFromUrl(url);
    if (enabled && !gameId) {
      liveFeedConfig.error = 'Enter a valid PlayHQ game-centre URL.';
      syncLiveFeedState();
      io.emit('state', state);
      return;
    }
    configureLiveFeed(url, enabled, useScore, useTime, pollSeconds);
    syncLiveFeedState();
    io.emit('state', state);
  });

  socket.on('increment', ({ team, points }) => {
    if (!['home','away'].includes(team)) return;
    const pts = Number(points) || 0;
    state[team].score += pts;
    // emit a short-lived delta event so displays can animate point pickups
    io.emit('scoreDelta', { team, points: pts });
    io.emit('state', state);
  });

  socket.on('foul', ({ team, delta }) => {
    if (!['home','away'].includes(team)) return;
    state[team].fouls = Math.max(0, state[team].fouls + Number(delta));
    updateBonusFlags();
    io.emit('state', state);
  });

  socket.on('timeout', ({ team }) => {
    if (!['home','away'].includes(team)) return;
    if (state[team].timeoutsRemaining > 0) {
      state[team].timeoutsRemaining -= 1;
      io.emit('announceTimeout', {
        team,
        duration: 4,
        label: state[team].shortName || state[team].name || team.toUpperCase()
      });
      io.emit('state', state);
    }
  });

  socket.on('clock', ({ action, value }) => {
    if (action === 'start') {
      if (!clockTimer) clockTimer = setInterval(tick, 1000);
      state.running = true;
    } else if (action === 'pause') {
      state.running = false;
    } else if (action === 'set') {
      state.clock = Number(value) || state.clock;
    } else if (action === 'reset') {
      state.clock = state.periodLengthsSec;
      state.running = false;
    }
    io.emit('state', state);
  });

  socket.on('tipoff', ({ action, value, title, showScore }) => {
    const allowedTitles = ['Time to Tip Off', 'End of Q1', 'HT', 'End of Qt3', 'FT'];
    if (action === 'start' && state.tipoffSeconds > 0) {
      if (allowedTitles.includes(title)) state.tipoffTitle = title;
      if (typeof showScore === 'boolean') state.tipoffShowScore = showScore;
      if (!clockTimer) clockTimer = setInterval(tick, 1000);
      state.tipoffRunning = true;
    } else if (action === 'pause') {
      state.tipoffRunning = false;
    } else if (action === 'set') {
      state.tipoffSeconds = Math.max(0, Number(value) || 0);
    } else if (action === 'title') {
      if (allowedTitles.includes(value)) state.tipoffTitle = value;
    } else if (action === 'scoreVisibility') {
      if (typeof value === 'boolean') state.tipoffShowScore = value;
    } else if (action === 'reset') {
      state.tipoffSeconds = 1800;
      state.tipoffRunning = false;
      state.tipoffTitle = 'Time to Tip Off';
      state.tipoffShowScore = true;
    }
    io.emit('state', state);
  });

  socket.on('setQuarter', ({ quarter }) => {
    state.quarter = Number(quarter) || state.quarter;
    // apply FIBA timeout reset when entering second half
    if (state.quarter === 3) {
      state.home.timeoutsRemaining = 3;
      state.away.timeoutsRemaining = 3;
    }
    io.emit('state', state);
  });

  socket.on('reset', () => {
    state.home.score = 0;
    state.away.score = 0;
    state.home.fouls = 0;
    state.away.fouls = 0;
    state.home.lineup.forEach((player) => { player.points = 0; });
    state.away.lineup.forEach((player) => { player.points = 0; });
    state.home.lineup.forEach((player) => { player.fouls = 0; });
    state.away.lineup.forEach((player) => { player.fouls = 0; });
    state.home.timeoutsRemaining = 2;
    state.away.timeoutsRemaining = 2;
    state.quarter = 1;
    state.clock = state.periodLengthsSec;
    state.running = false;
    state.tipoffSeconds = 1800;
    state.tipoffRunning = false;
    state.tipoffTitle = 'Time to Tip Off';
    state.tipoffShowScore = true;
    updateBonusFlags();
    io.emit('state', state);
  });

  socket.on('announceFoul', (payload) => {
    // payload: { team: 'home'|'away', playerNumber: '23', type: 'Personal', duration: 5 }
    io.emit('announceFoul', payload);
  });

  socket.on('showPlayerStats', ({ team, playerNumber, duration }) => {
    if (!['home', 'away'].includes(team)) return;
    const number = String(playerNumber || '').trim();
    const livePlayers = state.liveStats?.[team] || [];
    const player = livePlayers.find((entry) => String(entry.number) === number) || state[team].lineup.find((entry) => String(entry.number) === number);
    if (!player) {
      socket.emit('playerStatsError', `No live statistics found for ${state[team].shortName || state[team].name} #${number}.`);
      return;
    }
    io.emit('playerStatsAnnouncement', {
      team,
      teamName: state[team].shortName || state[team].name,
      teamColor: state[team].color,
      player,
      duration: Math.max(1, Math.min(30, Number(duration) || 8))
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
