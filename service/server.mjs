import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';
import QRCode from 'qrcode';
import steamSessionPackage from 'steam-session';
import shareCodePackage from 'globaloffensive-sharecode';
import unbzip2 from 'unbzip2-stream';
import { parseHeader } from '@laihoe/demoparser2';

const { LoginSession, EAuthTokenPlatformType } = steamSessionPackage;
const { ShareCode } = shareCodePackage;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'stackline.db');
const tokenPath = join(dataDir, 'steam-refresh-token');
const importAccountPath = join(dataDir, 'steam-import-account');
const credentialHistoryPath = join(dataDir, 'credential-history.json');
const publishedPath = join(dataDir, 'published-view.json');
const lineupsPath = join(dataDir, 'lineups.json');
const port = 4300;
const steamIdBase = 76561197960265728n;

await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS share_codes (code TEXT PRIMARY KEY, discovered_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'discovered');
  CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, discovered_count INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT 'running', message TEXT);
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, share_code TEXT NOT NULL UNIQUE, played_at TEXT NOT NULL, map TEXT NOT NULL, replay_url TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0,
    team_a_score INTEGER NOT NULL DEFAULT 0, team_b_score INTEGER NOT NULL DEFAULT 0,
    user_team INTEGER, result TEXT NOT NULL DEFAULT 'unknown', imported_at TEXT NOT NULL,
    FOREIGN KEY (share_code) REFERENCES share_codes(code)
  );
  CREATE TABLE IF NOT EXISTS players (account_id INTEGER PRIMARY KEY, steam_id64 TEXT NOT NULL UNIQUE, name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS match_players (
    match_id TEXT NOT NULL, account_id INTEGER NOT NULL, team INTEGER NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, assists INTEGER NOT NULL DEFAULT 0,
    headshots INTEGER NOT NULL DEFAULT 0, mvps INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, rating REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, account_id), FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES players(account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_share_codes_status ON share_codes(status);
  CREATE INDEX IF NOT EXISTS idx_match_players_account ON match_players(account_id);
  PRAGMA optimize;
`);

const steamState = {
  status: existsSync(tokenPath) ? 'reconnecting' : 'not_connected',
  message: existsSync(tokenPath) ? 'Restoring saved Steam session…' : 'Steam approval is required once.',
  qrDataUrl: '', changedAt: new Date().toISOString(),
};
const importState = { running: false, total: 0, processed: 0, imported: 0, failed: 0, message: '' };
const mapState = { running: false, total: 0, processed: 0, resolved: 0, failed: 0, message: '' };
const backfillState = { running: false, target: 0, pages: 0, seen: 0, imported: 0, skipped: 0, failed: 0, message: '' };
const liveState = { enabled: false, checkedAt: '', message: '' };
// Valve only publishes a match-sharing code once a match has finished, so this
// is "shortly after each match ends", not mid-match. Five minutes keeps the
// page current without hammering an API that already rate-limits this service.
const liveSyncIntervalMs = 5 * 60_000;
let liveSyncTimer = null;
let liveSyncRunning = false;
let loginSession = null;
let steamUser = null;
let csgo = null;
let gcReadyPromise = null;
let importPromise = null;
let mapPromise = null;
let backfillPromise = null;
const pendingMatches = new Map();

function setSteamState(status, message, qrDataUrl = steamState.qrDataUrl) {
  Object.assign(steamState, { status, message, qrDataUrl, changedAt: new Date().toISOString() });
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

async function readConfig() {
  if (!existsSync(envPath)) return {};
  return parseEnv(await readFile(envPath, 'utf8'));
}

function clean(value) { return String(value ?? '').replace(/[\r\n]/g, '').trim(); }
function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
function extractShareCode(value) { return clean(value).match(/CSGO-[A-Za-z0-9-]+/)?.[0] ?? ''; }
function accountToSteamId(accountId) { return (steamIdBase + BigInt(accountId)).toString(); }
function steamIdToAccount(steamId) { return Number(BigInt(steamId) - steamIdBase); }
function asString(value) { return value === null || value === undefined ? '' : value.toString(); }

function ratingFor({ kills, deaths, assists, rounds }) {
  const safeRounds = Math.max(1, rounds);
  const killRating = (kills / safeRounds) / 0.679;
  const survivalRating = ((safeRounds - deaths) / safeRounds) / 0.317;
  const assistRating = (assists / safeRounds) / 0.165;
  return Math.max(0, Math.min(3, (killRating * 0.5) + (survivalRating * 0.35) + (assistRating * 0.15)));
}

async function resolveSteamId(value, apiKey) {
  const input = clean(value);
  const direct = input.match(/(?:profiles\/)?(7656119\d{10})/)?.[1];
  if (direct) return direct;
  const vanity = input.match(/steamcommunity\.com\/id\/([^/?#]+)/i)?.[1] ?? (!input.includes('/') ? input : '');
  if (!vanity || !apiKey) return '';
  const url = new URL('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('vanityurl', vanity);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) return '';
  const payload = await response.json();
  return payload?.response?.success === 1 ? payload.response.steamid : '';
}

async function writeConfig(updates) {
  const next = { ...await readConfig(), ...updates };
  const keys = ['CS2_GAME_AUTH_CODE', 'STEAM_WEB_API_KEY', 'STEAM_ID64', 'CS2_KNOWN_SHARE_CODE'];
  const temporary = `${envPath}.tmp`;
  await writeFile(temporary, `${keys.map((key) => `${key}=${clean(next[key])}`).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, envPath);
  return next;
}

function readImportAccount() {
  if (!existsSync(importAccountPath)) return '';
  try { return clean(readFileSync(importAccountPath, 'utf8')); } catch { return ''; }
}

async function writeImportAccount(steamId64) {
  const value = clean(steamId64);
  if (!value) { await unlink(importAccountPath).catch(() => {}); return ''; }
  const temporary = `${importAccountPath}.tmp`;
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, importAccountPath);
  return value;
}

async function saveRefreshToken(token) {
  const temporary = `${tokenPath}.tmp`;
  await writeFile(temporary, clean(token), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, tokenPath);
  await chmod(tokenPath, 0o600).catch(() => {});
}

async function fetchPlayerNames(accountIds) {
  if (!accountIds.length) return;
  const config = await readConfig();
  if (!config.STEAM_WEB_API_KEY) return;
  const update = db.prepare('UPDATE players SET name = ?, avatar_url = ? WHERE steam_id64 = ?');
  for (let offset = 0; offset < accountIds.length; offset += 100) {
    const batch = accountIds.slice(offset, offset + 100);
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    url.searchParams.set('key', config.STEAM_WEB_API_KEY);
    url.searchParams.set('steamids', batch.map(accountToSteamId).join(','));
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) continue;
    const payload = await response.json();
    for (const player of payload?.response?.players ?? []) {
      update.run(clean(player.personaname) || `Player ${player.steamid.slice(-4)}`, clean(player.avatarfull), player.steamid);
    }
    await delay(250);
  }
}

function storeMatch(match, shareCode, configuredSteamId) {
  const final = (Array.isArray(match.roundstatsall) ? match.roundstatsall : []).at(-1);
  if (!final?.reservation?.account_ids?.length) throw new Error('Valve returned no final player scoreboard.');
  const accountIds = final.reservation.account_ids.map(Number).filter(Boolean);
  const playerCount = Math.min(accountIds.length, final.kills?.length ?? accountIds.length);
  if (!playerCount) throw new Error('Valve returned an empty scoreboard.');
  const teamSize = Math.ceil(playerCount / 2);
  const scores = Array.from(final.team_scores ?? []).map(Number);
  const scoreA = scores[0] ?? 0;
  const scoreB = scores[1] ?? 0;
  const roundCount = Math.max(1, scoreA + scoreB, Number(final.round) || 0);
  const userIndex = accountIds.indexOf(steamIdToAccount(configuredSteamId));
  const userTeam = userIndex < 0 ? null : (userIndex < teamSize ? 0 : 1);
  const result = userTeam === null ? 'unknown' : scoreA === scoreB ? 'draw' : ((userTeam === 0 ? scoreA > scoreB : scoreB > scoreA) ? 'win' : 'loss');
  const replayUrl = typeof final.map === 'string' && /^https?:\/\//i.test(final.map) ? final.map : '';
  const map = clean(match.watchablematchinfo?.game_map) || 'Unknown map';
  const matchId = asString(match.matchid);
  const playedAt = new Date(Number(match.matchtime || 0) * 1000).toISOString();
  const importedAt = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO matches (id, share_code, played_at, map, replay_url, duration_seconds, rounds, team_a_score, team_b_score, user_team, result, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET share_code=excluded.share_code, played_at=excluded.played_at, map=excluded.map,
      replay_url=excluded.replay_url, duration_seconds=excluded.duration_seconds, rounds=excluded.rounds,
      team_a_score=excluded.team_a_score, team_b_score=excluded.team_b_score, user_team=excluded.user_team,
      result=excluded.result, imported_at=excluded.imported_at`)
      .run(matchId, shareCode, playedAt, map, replayUrl, Number(final.match_duration) || 0, roundCount, scoreA, scoreB, userTeam, result, importedAt);
    const upsertPlayer = db.prepare(`INSERT INTO players (account_id, steam_id64, name) VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING`);
    const upsertStats = db.prepare(`INSERT INTO match_players (match_id, account_id, team, kills, deaths, assists, headshots, mvps, score, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(match_id, account_id) DO UPDATE SET team=excluded.team,
      kills=excluded.kills, deaths=excluded.deaths, assists=excluded.assists, headshots=excluded.headshots,
      mvps=excluded.mvps, score=excluded.score, rating=excluded.rating`);
    for (let index = 0; index < playerCount; index += 1) {
      const accountId = accountIds[index];
      const steamId64 = accountToSteamId(accountId);
      const kills = Number(final.kills?.[index]) || 0;
      const deaths = Number(final.deaths?.[index]) || 0;
      const assists = Number(final.assists?.[index]) || 0;
      const headshots = Number(final.enemy_headshots?.[index]) || 0;
      const mvps = Number(final.mvps?.[index]) || 0;
      const score = Number(final.scores?.[index]) || 0;
      upsertPlayer.run(accountId, steamId64, steamId64 === configuredSteamId ? 'You' : `Player ${steamId64.slice(-4)}`);
      upsertStats.run(matchId, accountId, index < teamSize ? 0 : 1, kills, deaths, assists, headshots, mvps, score, ratingFor({ kills, deaths, assists, rounds: roundCount }));
    }
    db.prepare("UPDATE share_codes SET status = 'imported' WHERE code = ?").run(shareCode);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return accountIds;
}

function requestMatch(shareCode, timeoutMs = 12_000) {
  return new Promise((resolveMatch, rejectMatch) => {
    const timer = setTimeout(() => {
      pendingMatches.delete(shareCode);
      rejectMatch(new Error('Valve did not return this match in time.'));
    }, timeoutMs);
    pendingMatches.set(shareCode, { resolve: resolveMatch, reject: rejectMatch, timer });
    try { csgo.requestGame(shareCode); }
    catch (error) { clearTimeout(timer); pendingMatches.delete(shareCode); rejectMatch(error); }
  });
}

async function connectSteam(refreshToken) {
  if (gcReadyPromise) return gcReadyPromise;
  gcReadyPromise = new Promise((resolveGc, rejectGc) => {
    setSteamState('connecting', 'Signing in to Steam…', '');
    steamUser = new SteamUser({ renewRefreshTokens: true, dataDirectory: join(dataDir, 'steam-user') });
    csgo = new GlobalOffensive(steamUser);
    let settled = false;
    const fail = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSteamState('error', `Steam connection failed: ${message}`, '');
      if (!settled) { settled = true; gcReadyPromise = null; rejectGc(error instanceof Error ? error : new Error(message)); }
    };
    const timeout = setTimeout(() => fail(new Error('Steam Game Coordinator connection timed out.')), 60_000);
    steamUser.on('error', fail);
    steamUser.on('refreshToken', (token) => { void saveRefreshToken(token); });
    steamUser.once('loggedOn', () => {
      const loggedSteamId = steamUser.steamID?.getSteamID64?.() ?? '';
      // Any approved account may fetch this archive, so record which one did
      // rather than refusing a deliberate second account.
      if (loggedSteamId && loggedSteamId !== readImportAccount()) void writeImportAccount(loggedSteamId);
      setSteamState('connecting_gc', 'Steam approved. Connecting to the CS2 Game Coordinator…', '');
      steamUser.gamesPlayed([730], true);
    });
    csgo.on('matchList', (matches) => {
      for (const match of matches ?? []) {
        const matchId = asString(match.matchid);
        for (const [code, pending] of pendingMatches) {
          try {
            if (asString(new ShareCode(code).decode().matchId) !== matchId) continue;
          } catch { continue; }
          clearTimeout(pending.timer);
          pendingMatches.delete(code);
          pending.resolve(match);
          break;
        }
      }
    });
    csgo.once('connectedToGC', () => {
      clearTimeout(timeout);
      settled = true;
      setSteamState('connected', 'Steam and the CS2 Game Coordinator are connected.', '');
      resolveGc();
      void startImport();
    });
    try { steamUser.logOn({ refreshToken }); } catch (error) { fail(error); }
  });
  return gcReadyPromise;
}

async function forgetSteamAccount() {
  try { steamUser?.gamesPlayed([], true); steamUser?.logOff(); } catch {}
  steamUser = null;
  csgo = null;
  gcReadyPromise = null;
  try { loginSession?.cancelLoginAttempt?.(); } catch {}
  loginSession = null;
  await unlink(tokenPath).catch(() => {});
  await writeImportAccount('');
  setSteamState('idle', 'No Steam account approved yet.', '');
}

async function startQrLogin(forceNewAccount = false) {
  if (forceNewAccount) await forgetSteamAccount();
  if (steamState.status === 'connected') return;
  if (!forceNewAccount && existsSync(tokenPath)) {
    await connectSteam(clean(await readFile(tokenPath, 'utf8')));
    return;
  }
  if (loginSession && ['qr_ready', 'waiting_approval'].includes(steamState.status)) return;
  loginSession = new LoginSession(EAuthTokenPlatformType.SteamClient);
  loginSession.loginTimeout = 180_000;
  loginSession.on('remoteInteraction', () => setSteamState('waiting_approval', 'QR scanned—tap Approve in Steam Mobile.', steamState.qrDataUrl));
  loginSession.on('error', (error) => setSteamState('error', `Steam approval failed: ${error.message}`, ''));
  loginSession.on('authenticated', () => {
    void (async () => {
      const approvedSteamId = loginSession.steamID?.getSteamID64?.() ?? '';
      await writeImportAccount(approvedSteamId);
      await saveRefreshToken(loginSession.refreshToken);
      await connectSteam(loginSession.refreshToken);
    })().catch((error) => setSteamState('error', error.message, ''));
  });
  setSteamState('starting_qr', 'Creating secure Steam QR code…', '');
  const details = await loginSession.startWithQR();
  const qrDataUrl = await QRCode.toDataURL(details.qrChallengeUrl, { width: 320, margin: 2, color: { dark: '#101210', light: '#f4f5ef' } });
  setSteamState('qr_ready', 'Scan with Steam Mobile, then approve the sign-in.', qrDataUrl);
}

async function startImport() {
  if (importPromise) return importPromise;
  importPromise = (async () => {
    const config = await readConfig();
    if (!config.STEAM_ID64) throw new Error('SteamID64 is missing.');
    if (steamState.status !== 'connected') {
      if (!existsSync(tokenPath)) throw new Error('Approve Steam first.');
      await connectSteam(clean(await readFile(tokenPath, 'utf8')));
    }
    const codes = db.prepare("SELECT code FROM share_codes WHERE status != 'imported' ORDER BY rowid DESC LIMIT 1000").all();
    Object.assign(importState, { running: true, total: codes.length, processed: 0, imported: 0, failed: 0, message: codes.length ? 'Reading Valve scoreboards…' : 'Archive is up to date.' });
    const allAccounts = new Set();
    for (const { code } of codes) {
      try {
        const match = await requestMatch(code);
        for (const accountId of storeMatch(match, code, config.STEAM_ID64)) allAccounts.add(accountId);
        importState.imported += 1;
      } catch (error) {
        importState.failed += 1;
        db.prepare("UPDATE share_codes SET status = 'retry' WHERE code = ?").run(code);
        console.warn(`Could not import match ${code.slice(0, 10)}…: ${error.message}`);
      } finally { importState.processed += 1; }
      await delay(850);
    }
    const knownAccounts = db.prepare('SELECT account_id AS accountId FROM players').all().map((row) => Number(row.accountId));
    await fetchPlayerNames([...new Set([...knownAccounts, ...allAccounts])]).catch(() => {});
    importState.running = false;
    importState.message = importState.imported
      ? `Analyzed ${importState.imported} match${importState.imported === 1 ? '' : 'es'} from Valve.`
      : (codes.length ? 'Valve did not return any scoreboards yet. Press Analyze to retry.' : 'Archive is up to date.');
    try { steamUser?.gamesPlayed([], true); steamUser?.logOff(); } catch {}
    steamUser = null;
    csgo = null;
    gcReadyPromise = null;
    setSteamState('ready', 'Steam approval is saved. Ready for the next match sync.', '');
    if (importState.imported) await republishLive().catch(() => {});
    return { ...importState };
  })().finally(() => { importPromise = null; });
  return importPromise;
}

async function readMapFromReplay(replayUrl) {
  const response = await fetch(replayUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Replay unavailable (${response.status}).`);
  const source = Readable.fromWeb(response.body);
  const decompressor = unbzip2();
  const chunks = [];
  let size = 0;
  await new Promise((resolveStream, rejectStream) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error && size < 1024) rejectStream(error);
      else resolveStream();
    };
    decompressor.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= 16 * 1024 * 1024) {
        source.unpipe(decompressor);
        source.destroy();
        decompressor.destroy();
        finish();
      }
    });
    decompressor.once('end', () => finish());
    decompressor.once('error', (error) => finish(error));
    source.once('error', (error) => finish(error));
    source.pipe(decompressor);
  });
  const header = parseHeader(Buffer.concat(chunks));
  const mapName = clean(header?.map_name);
  if (!/^de_[a-z0-9_]+$/i.test(mapName)) throw new Error('Replay header did not contain a valid map name.');
  return mapName.toLowerCase();
}

function normalizedMapName(label) {
  const name = clean(label).toLowerCase();
  const aliases = { 'dust ii': 'dust2' };
  const slug = aliases[name] ?? name.replace(/[^a-z0-9]+/g, '');
  return slug ? `de_${slug}` : '';
}

function mapsFromPremierHistory(html) {
  const maps = [];
  const pattern = /<td>\s*Premier\s+([^<]+)<\/td>[\s\S]*?<td>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT)\s*<\/td>/gi;
  for (const match of html.matchAll(pattern)) {
    const map = normalizedMapName(match[1]);
    const playedAt = new Date(match[2]).toISOString();
    if (map && playedAt) maps.push({ map, playedAt });
  }
  return maps;
}

function decodeHistoryText(value) {
  return clean(String(value ?? '').replace(/<[^>]*>/g, '').replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal))).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'));
}

function parseHistoryDuration(value) {
  const parts = clean(value).split(':').map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? (parts[0] * 60) + parts[1] : 0;
}

function premierMatchesFromHistory(html) {
  const matches = [];
  const segments = String(html).split(/<tr>\s*<td class="val_left">/i).slice(1);
  const playerPattern = /<div class="playerAvatar[^"]*">\s*<a href="([^"]+)"><img src="([^"]*)"[^>]*data-miniprofile="(\d+)"[^>]*><\/a><\/div>\s*<div class="playerNickname[^"]*"><a class="linkTitle"[^>]*>([\s\S]*?)<\/a><\/div>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi;
  for (const segment of segments) {
    const mapLabel = segment.match(/Premier\s+([^<]+)<\/td>/i)?.[1];
    const dateLabel = segment.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT)/i)?.[1];
    const scoreMatch = segment.match(/csgo_scoreboard_score">\s*(\d+)\s*:\s*(\d+)/i);
    if (!mapLabel || !dateLabel || !scoreMatch) continue;
    const players = [];
    for (const playerMatch of segment.matchAll(playerPattern)) {
      const accountId = Number(playerMatch[3]);
      const kills = Number(decodeHistoryText(playerMatch[6])) || 0;
      const assists = Number(decodeHistoryText(playerMatch[7])) || 0;
      const deaths = Number(decodeHistoryText(playerMatch[8])) || 0;
      const mvpText = decodeHistoryText(playerMatch[9]);
      const hsp = Number(decodeHistoryText(playerMatch[10]).replace('%', '')) || 0;
      players.push({
        accountId,
        steamId64: accountToSteamId(accountId),
        name: decodeHistoryText(playerMatch[4]) || `Player ${accountId}`,
        avatarUrl: clean(playerMatch[2]).replace(/&amp;/g, '&'),
        kills,
        deaths,
        assists,
        headshots: Math.max(0, Math.round(kills * hsp / 100)),
        mvps: Number(mvpText.match(/\d+/)?.[0]) || (mvpText.includes('★') ? 1 : 0),
        score: Number(decodeHistoryText(playerMatch[11])) || 0,
      });
    }
    if (players.length !== 10) continue;
    const playedAt = new Date(dateLabel).toISOString();
    const durationLabel = segment.match(/Match Duration:\s*([0-9:]+)/i)?.[1] ?? '';
    const replayUrl = clean(segment.match(/href="(https?:\/\/replay[^"\s]+\.dem\.bz2)"/i)?.[1] ?? '').replace(/&amp;/g, '&');
    matches.push({ playedAt, map: normalizedMapName(mapLabel), scoreA: Number(scoreMatch[1]), scoreB: Number(scoreMatch[2]), durationSeconds: parseHistoryDuration(durationLabel), replayUrl, players });
  }
  return matches;
}

function storeHistoryMatch(match, configuredSteamId) {
  if (db.prepare('SELECT 1 FROM matches WHERE played_at = ? LIMIT 1').get(match.playedAt)) return false;
  const matchEpoch = Math.floor(new Date(match.playedAt).getTime() / 1000);
  const matchId = `history-${matchEpoch}`;
  const shareCode = `HISTORY-${matchEpoch}`;
  const rounds = Math.max(1, match.scoreA + match.scoreB);
  const ownerAccountId = steamIdToAccount(configuredSteamId);
  const ownerIndex = match.players.findIndex((player) => player.accountId === ownerAccountId);
  const userTeam = ownerIndex < 0 ? null : (ownerIndex < 5 ? 0 : 1);
  const result = userTeam === null ? 'unknown' : match.scoreA === match.scoreB ? 'draw' : ((userTeam === 0 ? match.scoreA > match.scoreB : match.scoreB > match.scoreA) ? 'win' : 'loss');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT OR IGNORE INTO share_codes (code, discovered_at, status) VALUES (?, ?, 'imported')").run(shareCode, match.playedAt);
    db.prepare(`INSERT INTO matches (id, share_code, played_at, map, replay_url, duration_seconds, rounds, team_a_score, team_b_score, user_team, result, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(matchId, shareCode, match.playedAt, match.map || 'Unknown map', match.replayUrl, match.durationSeconds, rounds, match.scoreA, match.scoreB, userTeam, result, new Date().toISOString());
    const upsertPlayer = db.prepare(`INSERT INTO players (account_id, steam_id64, name, avatar_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, avatar_url=CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE players.avatar_url END`);
    const insertStats = db.prepare(`INSERT INTO match_players (match_id, account_id, team, kills, deaths, assists, headshots, mvps, score, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    match.players.forEach((player, index) => {
      upsertPlayer.run(player.accountId, player.steamId64, player.name, player.avatarUrl);
      insertStats.run(matchId, player.accountId, index < 5 ? 0 : 1, player.kills, player.deaths, player.assists, player.headshots, player.mvps, player.score, ratingFor({ ...player, rounds }));
    });
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function steamWebSession() {
  if (!existsSync(tokenPath)) throw new Error('Approve Steam once before backfilling older history.');
  const client = new SteamUser({ dataDirectory: join(dataDir, 'steam-history-user') });
  const cookies = await new Promise((resolveCookies, rejectCookies) => {
    const timer = setTimeout(() => rejectCookies(new Error('Steam web session timed out.')), 45_000);
    client.once('loggedOn', () => client.webLogOn());
    client.once('webSession', (_sessionId, webCookies) => { clearTimeout(timer); resolveCookies(webCookies); });
    client.once('error', (error) => { clearTimeout(timer); rejectCookies(error); });
    readFile(tokenPath, 'utf8').then((token) => client.logOn({ refreshToken: clean(token) })).catch(rejectCookies);
  });
  return { client, cookies };
}

async function startHistoryBackfill(requestedTarget) {
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    const currentTotal = Number(db.prepare('SELECT COUNT(*) AS count FROM matches').get().count);
    const numericTarget = Number(requestedTarget);
    const target = Number.isFinite(numericTarget) ? Math.max(currentTotal, Math.min(5000, Math.floor(numericTarget))) : Math.max(currentTotal, 250);
    Object.assign(backfillState, { running: true, target, pages: 0, seen: 0, imported: 0, skipped: 0, failed: 0, message: `Opening Steam history to reach up to ${target} matches…` });
    if (currentTotal >= target) {
      backfillState.running = false;
      backfillState.message = `The archive already contains ${currentTotal} matches, meeting the requested target of ${target}.`;
      return { ...backfillState };
    }
    const config = await readConfig();
    const { client, cookies } = await steamWebSession();
    try {
      const headers = { Cookie: cookies.join('; '), 'User-Agent': 'Stackline local archive' };
      const firstResponse = await fetch('https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier', { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (!firstResponse.ok) throw new Error(`Steam Premier history failed (${firstResponse.status}).`);
      let html = await firstResponse.text();
      let continueToken = html.match(/g_sGcContinueToken\s*=\s*'([^']+)'/)?.[1] ?? '';
      const sessionCookie = cookies.join(';').match(/(?:^|;\s*)sessionid=([^;]+)/)?.[1] ?? '';
      const sessionId = decodeURIComponent(sessionCookie);
      const historyUrl = new URL(firstResponse.url);
      historyUrl.search = '';
      let rateLimitRetries = 0;
      let historyExhausted = false;
      for (let page = 0; page < 1000; page += 1) {
        const parsedMatches = premierMatchesFromHistory(html);
        backfillState.pages += 1;
        backfillState.seen += parsedMatches.length;
        let totalMatches = Number(db.prepare('SELECT COUNT(*) AS count FROM matches').get().count);
        for (const match of parsedMatches) {
          if (totalMatches >= target) break;
          try {
            if (storeHistoryMatch(match, config.STEAM_ID64)) { backfillState.imported += 1; totalMatches += 1; }
            else backfillState.skipped += 1;
          } catch (error) {
            backfillState.failed += 1;
            console.warn(`Could not backfill ${match.playedAt}: ${error.message}`);
          }
        }
        backfillState.message = `Scanned ${backfillState.seen} Premier matches · imported ${backfillState.imported} older matches…`;
        if (totalMatches >= target) break;
        if (!continueToken || !sessionId) { historyExhausted = true; break; }
        const ajaxUrl = new URL(historyUrl);
        ajaxUrl.searchParams.set('ajax', '1');
        ajaxUrl.searchParams.set('tab', 'matchhistorypremier');
        ajaxUrl.searchParams.set('continue_token', continueToken);
        ajaxUrl.searchParams.set('sessionid', sessionId);
        const response = await fetch(ajaxUrl, { headers, signal: AbortSignal.timeout(30_000) });
        if (response.status === 429) {
          rateLimitRetries += 1;
          if (rateLimitRetries > 4) throw new Error('Steam rate-limited the history backfill. Progress is saved; retry later to continue.');
          await delay(15_000);
          page -= 1;
          continue;
        }
        if (!response.ok) throw new Error(`Steam Premier history page failed (${response.status}).`);
        const payload = await response.json();
        if (!payload?.success) break;
        html = String(payload.html ?? '');
        continueToken = clean(payload.continue_token);
        rateLimitRetries = 0;
        await delay(750);
      }
      const finalTotal = Number(db.prepare('SELECT COUNT(*) AS count FROM matches').get().count);
      backfillState.running = false;
      backfillState.message = finalTotal >= target
        ? `Archive reached ${finalTotal} matches (requested target: ${target}).`
        : historyExhausted
          ? `Steam history ended at ${finalTotal} available Premier matches; the requested target was ${target}.`
          : `Backfill stopped at ${finalTotal} matches after importing ${backfillState.imported}.`;
      return { ...backfillState };
    } finally {
      try { client.logOff(); } catch {}
    }
  })().catch((error) => {
    backfillState.running = false;
    backfillState.message = error instanceof Error ? error.message : 'History backfill failed.';
    throw error;
  }).finally(() => { backfillPromise = null; });
  return backfillPromise;
}

async function resolveMapsFromPremierHistory() {
  if (!existsSync(tokenPath)) return 0;
  const wanted = new Set(db.prepare("SELECT played_at AS playedAt FROM matches WHERE map = 'Unknown map'").all().map((row) => row.playedAt));
  if (!wanted.size) return 0;
  const webClient = new SteamUser({ dataDirectory: join(dataDir, 'steam-web-user') });
  let cookies = [];
  try {
    cookies = await new Promise((resolveCookies, rejectCookies) => {
      const timer = setTimeout(() => rejectCookies(new Error('Steam web session timed out.')), 45_000);
      webClient.once('loggedOn', () => webClient.webLogOn());
      webClient.once('webSession', (_sessionId, webCookies) => { clearTimeout(timer); resolveCookies(webCookies); });
      webClient.once('error', (error) => { clearTimeout(timer); rejectCookies(error); });
      readFile(tokenPath, 'utf8').then((token) => webClient.logOn({ refreshToken: clean(token) })).catch(rejectCookies);
    });
    const headers = { Cookie: cookies.join('; '), 'User-Agent': 'Stackline local archive' };
    const firstResponse = await fetch('https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier', {
      headers, redirect: 'follow', signal: AbortSignal.timeout(30_000),
    });
    if (!firstResponse.ok) throw new Error(`Steam Premier history failed (${firstResponse.status}).`);
    let html = await firstResponse.text();
    let continueToken = html.match(/g_sGcContinueToken\s*=\s*'([^']+)'/)?.[1] ?? '';
    const sessionCookie = cookies.join(';').match(/(?:^|;\s*)sessionid=([^;]+)/)?.[1] ?? '';
    const sessionId = decodeURIComponent(sessionCookie);
    const historyUrl = new URL(firstResponse.url);
    historyUrl.search = '';
    const update = db.prepare("UPDATE matches SET map = ? WHERE played_at = ? AND map = 'Unknown map'");
    let resolved = 0;

    for (let page = 0; page < 100; page += 1) {
      for (const item of mapsFromPremierHistory(html)) {
        if (!wanted.has(item.playedAt)) continue;
        const result = update.run(item.map, item.playedAt);
        if (Number(result.changes) > 0) resolved += 1;
        wanted.delete(item.playedAt);
      }
      if (!wanted.size || !continueToken || !sessionId) break;
      const ajaxUrl = new URL(historyUrl);
      ajaxUrl.searchParams.set('ajax', '1');
      ajaxUrl.searchParams.set('tab', 'matchhistorypremier');
      ajaxUrl.searchParams.set('continue_token', continueToken);
      ajaxUrl.searchParams.set('sessionid', sessionId);
      const response = await fetch(ajaxUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Steam Premier history page failed (${response.status}).`);
      const payload = await response.json();
      if (!payload?.success) break;
      html = String(payload.html ?? '');
      continueToken = clean(payload.continue_token);
      await delay(700);
    }
    return resolved;
  } finally {
    try { webClient.logOff(); } catch {}
  }
}

async function startMapResolution() {
  if (mapPromise) return mapPromise;
  mapPromise = (async () => {
    const matches = db.prepare("SELECT id, replay_url AS replayUrl FROM matches WHERE map = 'Unknown map' AND replay_url != '' ORDER BY played_at DESC").all();
    Object.assign(mapState, { running: true, total: matches.length, processed: 0, resolved: 0, failed: 0, message: matches.length ? 'Reading map names from Valve replay headers…' : 'Every available map name is resolved.' });
    let nextIndex = 0;
    const updateMap = db.prepare("UPDATE matches SET map = ? WHERE id = ? AND map = 'Unknown map'");
    async function worker() {
      while (nextIndex < matches.length) {
        const match = matches[nextIndex];
        nextIndex += 1;
        try {
          const mapName = await readMapFromReplay(match.replayUrl);
          updateMap.run(mapName, match.id);
          mapState.resolved += 1;
        } catch {
          mapState.failed += 1;
        } finally {
          mapState.processed += 1;
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (mapState.failed) {
      mapState.message = 'Checking your Steam Premier history for expired replays…';
      try {
        const historyResolved = await resolveMapsFromPremierHistory();
        mapState.resolved += historyResolved;
        mapState.failed = Math.max(0, mapState.failed - historyResolved);
      } catch (error) {
        console.warn(`Could not read Steam Premier history: ${error.message}`);
      }
    }
    mapState.running = false;
    mapState.message = mapState.failed
      ? `Resolved ${mapState.resolved} maps; ${mapState.failed} replay${mapState.failed === 1 ? '' : 's'} are no longer available from Valve.`
      : `Resolved all ${mapState.resolved} map names.`;
    return { ...mapState };
  })().finally(() => { mapPromise = null; });
  return mapPromise;
}

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'http://localhost:3000',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// A cheap fingerprint of everything /api/archive would return. The web interface
// polls status often but only re-downloads the archive when this value changes,
// which keeps a 1.5 MB payload off the wire on every tick.
function archiveRevision() {
  const m = db.prepare("SELECT COUNT(*) AS count, MAX(imported_at) AS imported, SUM(CASE WHEN map = 'Unknown map' THEN 1 ELSE 0 END) AS unresolved FROM matches").get();
  const rows = db.prepare('SELECT COUNT(*) AS count FROM match_players').get();
  const people = db.prepare('SELECT COUNT(*) AS count FROM players').get();
  return `${m.count}.${rows.count}.${people.count}.${m.unresolved ?? 0}.${m.imported ?? ''}`;
}

// Discovery and import fail independently: share codes arrive over the Web API
// while scoreboards need the Game Coordinator. Codes piling up unimported is the
// signal that live sharing has quietly stopped moving.
function liveBlockage() {
  const pending = Number(db.prepare("SELECT COUNT(*) AS count FROM share_codes WHERE status != 'imported'").get().count);
  if (!pending || importState.running || steamState.status === 'connected') return { pending, blocked: false, reason: '' };
  const reason = !existsSync(tokenPath)
    ? 'No Steam account is approved yet, so scoreboards cannot be imported.'
    : /elsewhere|game coordinator|steam network/i.test(steamState.message)
      ? 'The import account cannot reach the CS2 Game Coordinator, usually because that same account is playing CS2. Approve a second Steam account, or close CS2 and let it catch up.'
      : steamState.message || 'Scoreboards cannot be imported right now.';
  return { pending, blocked: true, reason };
}

// Previously used values can be recalled without ever sending a secret back to
// the browser: the interface lists masked labels and posts the entry's id, and
// the value is resolved here.
const historyFields = ['steamProfile', 'apiKey', 'knownCode', 'gameAuth'];
const secretFields = new Set(['apiKey', 'gameAuth']);

function maskValue(field, value) {
  const text = clean(value);
  if (!text) return '';
  if (field === 'steamProfile') return text;
  if (field === 'knownCode') return text.length > 16 ? `${text.slice(0, 10)}…${text.slice(-5)}` : text;
  return `••••••••${text.slice(-4)}`;
}

async function readCredentialHistory() {
  if (!existsSync(credentialHistoryPath)) return {};
  try {
    const payload = JSON.parse(await readFile(credentialHistoryPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

async function rememberCredential(field, value) {
  const text = clean(value);
  if (!historyFields.includes(field) || !text) return;
  const history = await readCredentialHistory();
  const entries = Array.isArray(history[field]) ? history[field].filter((entry) => entry?.value !== text) : [];
  entries.unshift({ id: randomUUID(), value: text, savedAt: new Date().toISOString() });
  history[field] = entries.slice(0, 5);
  const temporary = `${credentialHistoryPath}.tmp`;
  await writeFile(temporary, JSON.stringify(history), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, credentialHistoryPath);
}

async function recentCredentials() {
  const history = await readCredentialHistory();
  const result = {};
  for (const field of historyFields) {
    result[field] = (Array.isArray(history[field]) ? history[field] : [])
      .filter((entry) => entry?.id && entry?.value)
      .map((entry) => ({ id: entry.id, label: maskValue(field, entry.value), savedAt: entry.savedAt ?? '', secret: secretFields.has(field) }));
  }
  return result;
}

async function resolveCredential(field, rawValue, entryId) {
  const direct = clean(rawValue);
  if (direct) return direct;
  if (!entryId) return '';
  const history = await readCredentialHistory();
  const entry = (Array.isArray(history[field]) ? history[field] : []).find((candidate) => candidate?.id === clean(entryId));
  return entry ? clean(entry.value) : '';
}

async function statusPayload() {
  const config = await readConfig();
  const importAccount = readImportAccount();
  const blockage = liveBlockage();
  const codes = db.prepare('SELECT COUNT(*) AS count FROM share_codes').get();
  const matches = db.prepare('SELECT COUNT(*) AS count FROM matches').get();
  const players = db.prepare('SELECT COUNT(*) AS count FROM players').get();
  return {
    online: true,
    credentials: { gameAuth: Boolean(config.CS2_GAME_AUTH_CODE), apiKey: Boolean(config.STEAM_WEB_API_KEY), steamId: Boolean(config.STEAM_ID64), knownCode: Boolean(config.CS2_KNOWN_SHARE_CODE) },
    steamId64: config.STEAM_ID64 || '', discoveredCodes: Number(codes.count), analyzedMatches: Number(matches.count), playerCount: Number(players.count),
    archiveRevision: archiveRevision(),
    steam: {
      status: steamState.status, message: steamState.message, hasSavedSession: existsSync(tokenPath), qrDataUrl: steamState.qrDataUrl,
      importSteamId64: importAccount,
      importIsOwner: Boolean(importAccount && importAccount === config.STEAM_ID64),
    },
    importing: { ...importState },
    maps: { ...mapState },
    backfill: { ...backfillState },
    live: { ...liveState, ...blockage },
  };
}

function archivePayload() {
  return {
    matches: db.prepare(`SELECT id, share_code AS shareCode, played_at AS playedAt, map, duration_seconds AS durationSeconds,
      rounds, team_a_score AS teamAScore, team_b_score AS teamBScore, user_team AS userTeam, result FROM matches ORDER BY played_at DESC`).all(),
    players: db.prepare('SELECT account_id AS accountId, steam_id64 AS steamId64, name, avatar_url AS avatarUrl FROM players ORDER BY name COLLATE NOCASE').all(),
    stats: db.prepare(`SELECT match_id AS matchId, account_id AS accountId, team, kills, deaths, assists, headshots, mvps, score, rating FROM match_players`).all(),
  };
}

function emptyPublishedArchive() {
  return { matches: [], players: [], stats: [], published: null };
}

async function readPublishedArchive() {
  if (!existsSync(publishedPath)) return emptyPublishedArchive();
  try {
    const payload = JSON.parse(await readFile(publishedPath, 'utf8'));
    if (!Array.isArray(payload.matches) || !Array.isArray(payload.players) || !Array.isArray(payload.stats)) return emptyPublishedArchive();
    return payload;
  } catch {
    return emptyPublishedArchive();
  }
}

// Saved lineups are named player selections the owner can reapply in one click.
// They are stored beside the archive so they survive restarts and browser resets.
async function readLineups() {
  if (!existsSync(lineupsPath)) return [];
  try {
    const payload = JSON.parse(await readFile(lineupsPath, 'utf8'));
    if (!Array.isArray(payload.lineups)) return [];
    return payload.lineups.filter((lineup) => lineup && typeof lineup.id === 'string' && typeof lineup.name === 'string' && Array.isArray(lineup.playerIds));
  } catch {
    return [];
  }
}

async function writeLineups(lineups) {
  const sorted = [...lineups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const temporary = `${lineupsPath}.tmp`;
  await writeFile(temporary, JSON.stringify({ lineups: sorted }), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, lineupsPath);
  return sorted;
}

async function saveLineup(name, playerIds) {
  const label = clean(name).slice(0, 60);
  if (!label) throw new Error('Name this lineup before saving it.');
  const players = [...new Set((Array.isArray(playerIds) ? playerIds : []).map(Number).filter(Number.isInteger))];
  if (players.length < 2 || players.length > 5) throw new Error('Save a lineup of two to five players.');
  const lineups = await readLineups();
  const existing = lineups.find((lineup) => lineup.name.toLowerCase() === label.toLowerCase());
  if (existing) {
    existing.name = label;
    existing.playerIds = players;
    existing.savedAt = new Date().toISOString();
  } else {
    lineups.push({ id: randomUUID(), name: label, playerIds: players, savedAt: new Date().toISOString() });
  }
  return writeLineups(lineups);
}

async function deleteLineup(id) {
  const target = clean(id);
  const lineups = await readLineups();
  return writeLineups(lineups.filter((lineup) => lineup.id !== target));
}

async function publishSelection(selectedPlayerIds, live = false) {
  const config = await readConfig();
  const selected = [...new Set((Array.isArray(selectedPlayerIds) ? selectedPlayerIds : []).map(Number).filter(Number.isInteger))];
  if (selected.length < 2 || selected.length > 5) throw new Error('Select two to five players before publishing.');
  const ownerAccountId = steamIdToAccount(config.STEAM_ID64);
  if (!selected.includes(ownerAccountId)) throw new Error('The authenticated Steam player must be included.');
  const archive = archivePayload();
  const matchIds = new Set(archive.matches.filter((match) => {
    const present = new Set(archive.stats.filter((row) => row.matchId === match.id).map((row) => Number(row.accountId)));
    return selected.every((accountId) => present.has(accountId));
  }).map((match) => match.id));
  const matches = archive.matches.filter((match) => matchIds.has(match.id)).map((match) => {
    const publishedMatch = { ...match };
    delete publishedMatch.shareCode;
    return publishedMatch;
  });
  const stats = archive.stats.filter((row) => matchIds.has(row.matchId));
  const playerIds = new Set(stats.map((row) => Number(row.accountId)));
  const players = archive.players.filter((player) => playerIds.has(Number(player.accountId)));
  const payload = {
    matches,
    players,
    stats,
    published: { publishedAt: new Date().toISOString(), selectedPlayerIds: selected, ownerSteamId64: config.STEAM_ID64, matchCount: matches.length, live: Boolean(live) },
  };
  const temporary = `${publishedPath}.tmp`;
  await writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, publishedPath);
  if (live) startLiveSync();
  else stopLiveSync();
  return payload;
}

// When the owner leaves the view-only page live, every newly analyzed match is
// re-published under the lineup they already chose. Nothing new is exposed: the
// snapshot is rebuilt by the same code path, which strips share codes.
async function liveSyncTick() {
  if (liveSyncRunning || importState.running || backfillState.running || mapState.running) return;
  liveSyncRunning = true;
  try {
    if (!(await livePublishEnabled())) { stopLiveSync(); return; }
    const result = await syncShareCodes();
    // syncShareCodes only chains into an import while the Game Coordinator is
    // still connected, and the previous import logs off when it finishes.
    if (result.discovered) await startImport();
    liveState.message = result.discovered ? `Imported ${result.discovered} new match${result.discovered === 1 ? '' : 'es'}.` : 'No new matches yet.';
  } catch (error) {
    liveState.message = error instanceof Error ? error.message : 'Live check failed.';
  } finally {
    liveState.checkedAt = new Date().toISOString();
    liveSyncRunning = false;
  }
}

async function livePublishEnabled() {
  if (!existsSync(publishedPath)) return false;
  try {
    const current = JSON.parse(await readFile(publishedPath, 'utf8'));
    return Boolean(current?.published?.live);
  } catch {
    return false;
  }
}

function startLiveSync() {
  liveState.enabled = true;
  if (liveSyncTimer) return;
  liveSyncTimer = setInterval(() => { void liveSyncTick(); }, liveSyncIntervalMs);
  liveSyncTimer.unref?.();
  void liveSyncTick();
}

function stopLiveSync() {
  liveState.enabled = false;
  if (!liveSyncTimer) return;
  clearInterval(liveSyncTimer);
  liveSyncTimer = null;
}

async function republishLive() {
  if (!existsSync(publishedPath)) return false;
  try {
    const current = JSON.parse(await readFile(publishedPath, 'utf8'));
    const info = current?.published;
    if (!info?.live || !Array.isArray(info.selectedPlayerIds) || info.selectedPlayerIds.length < 2) return false;
    await publishSelection(info.selectedPlayerIds, true);
    return true;
  } catch {
    return false;
  }
}

async function syncShareCodes() {
  const config = await readConfig();
  const missing = [['Steam Web API key', config.STEAM_WEB_API_KEY], ['SteamID64', config.STEAM_ID64], ['Game Authentication Code', config.CS2_GAME_AUTH_CODE], ['recent match-sharing code', config.CS2_KNOWN_SHARE_CODE]]
    .filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}.`);
  const run = db.prepare('INSERT INTO sync_runs (started_at) VALUES (?)').run(new Date().toISOString());
  const latestSaved = db.prepare("SELECT code FROM share_codes WHERE code LIKE 'CSGO-%' ORDER BY rowid DESC LIMIT 1").get();
  let cursor = latestSaved?.code || config.CS2_KNOWN_SHARE_CODE;
  let discovered = 0;
  let rateLimitRetries = 0;
  let result = 'complete';
  let message = 'No newer matches are available yet.';
  try {
    for (let index = 0; index < 1000; index += 1) {
      const url = new URL('https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/');
      url.searchParams.set('key', config.STEAM_WEB_API_KEY);
      url.searchParams.set('steamid', config.STEAM_ID64);
      url.searchParams.set('steamidkey', config.CS2_GAME_AUTH_CODE);
      url.searchParams.set('knowncode', cursor);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.status === 429) {
        rateLimitRetries += 1;
        if (rateLimitRetries > 3) throw new Error('Valve is still rate-limiting requests. Progress is saved; wait one minute and press Sync again.');
        const retryAfterHeader = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? Math.min(retryAfterHeader * 1000, 30_000) : 15_000);
        index -= 1;
        continue;
      }
      if (response.status === 202) break;
      if (response.status === 412) throw new Error('Valve rejected the cursor. Enter a recent sharing code from your CS2 match history.');
      if (!response.ok) throw new Error(`Valve match-history request failed (${response.status}).`);
      const payload = await response.json();
      const nextCode = extractShareCode(payload?.result?.nextcode);
      if (!nextCode || nextCode === cursor) break;
      db.prepare('INSERT OR IGNORE INTO share_codes (code, discovered_at) VALUES (?, ?)').run(nextCode, new Date().toISOString());
      cursor = nextCode;
      await writeConfig({ CS2_KNOWN_SHARE_CODE: cursor });
      discovered += 1;
      rateLimitRetries = 0;
      await delay(2_200);
    }
    message = discovered ? `Discovered ${discovered} new match${discovered === 1 ? '' : 'es'}.` : message;
  } catch (error) {
    result = 'failed';
    message = error instanceof Error ? error.message : 'Synchronization failed.';
    throw error;
  } finally {
    db.prepare('UPDATE sync_runs SET finished_at = ?, discovered_count = ?, result = ?, message = ? WHERE id = ?').run(new Date().toISOString(), discovered, result, message, run.lastInsertRowid);
  }
  if (steamState.status === 'connected') void startImport();
  return { discovered, message };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return send(response, 204, {});
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/status') return send(response, 200, await statusPayload());
    if (request.method === 'GET' && url.pathname === '/api/archive') return send(response, 200, archivePayload());
    if (request.method === 'GET' && url.pathname === '/api/published') return send(response, 200, await readPublishedArchive());
    if (request.method === 'GET' && url.pathname === '/api/lineups') return send(response, 200, { lineups: await readLineups() });
    if (request.method === 'POST' && url.pathname === '/api/lineups') {
      const body = await bodyJson(request);
      return send(response, 200, { lineups: await saveLineup(body.name, body.playerIds) });
    }
    if (request.method === 'POST' && url.pathname === '/api/lineups/delete') {
      const body = await bodyJson(request);
      return send(response, 200, { lineups: await deleteLineup(body.id) });
    }
    if (request.method === 'POST' && url.pathname === '/api/publish') {
      const body = await bodyJson(request);
      const published = await publishSelection(body.selectedPlayerIds, body.live);
      return send(response, 200, { published: published.published });
    }
    if (request.method === 'POST' && url.pathname === '/api/maps') {
      if (!mapState.running) void startMapResolution().catch((error) => { mapState.running = false; mapState.message = error.message; });
      return send(response, 202, await statusPayload());
    }
    if (request.method === 'POST' && url.pathname === '/api/backfill') {
      const body = await bodyJson(request);
      if (!backfillState.running) void startHistoryBackfill(body.targetMatches).catch(() => {});
      return send(response, 202, await statusPayload());
    }
    if (request.method === 'POST' && url.pathname === '/api/steam/qr') {
      const body = await bodyJson(request).catch(() => ({}));
      await startQrLogin(Boolean(body.switchAccount));
      return send(response, 200, await statusPayload());
    }
    if (request.method === 'POST' && url.pathname === '/api/steam/signout') {
      await forgetSteamAccount();
      return send(response, 200, await statusPayload());
    }
    if (request.method === 'POST' && url.pathname === '/api/analyze') {
      if (importState.running) return send(response, 202, await statusPayload());
      void startImport().catch((error) => { importState.running = false; importState.message = error.message; });
      return send(response, 202, await statusPayload());
    }
    if (request.method === 'GET' && url.pathname === '/api/credentials/recent') return send(response, 200, await recentCredentials());
    if (request.method === 'POST' && url.pathname === '/api/config') {
      const body = await bodyJson(request);
      const current = await readConfig();
      const apiKey = await resolveCredential('apiKey', body.apiKey, body.apiKeyId) || current.STEAM_WEB_API_KEY;
      const profileInput = await resolveCredential('steamProfile', body.steamProfile, body.steamProfileId);
      const steamId = profileInput ? await resolveSteamId(profileInput, apiKey) : current.STEAM_ID64;
      const knownCodeInput = await resolveCredential('knownCode', body.knownCode, body.knownCodeId);
      const knownCode = knownCodeInput ? extractShareCode(knownCodeInput) : current.CS2_KNOWN_SHARE_CODE;
      // The authentication code has no field until now, so a regenerated one
      // could not be updated without editing the secret file by hand.
      const gameAuth = await resolveCredential('gameAuth', body.gameAuth, body.gameAuthId) || current.CS2_GAME_AUTH_CODE;
      if (!apiKey) return send(response, 400, { error: 'Enter a Steam Web API key.' });
      if (!steamId) return send(response, 400, { error: 'Enter a valid Steam profile URL or SteamID64.' });
      if (!knownCode) return send(response, 400, { error: 'Enter a valid recent CSGO-… match-sharing code.' });
      await writeConfig({ STEAM_WEB_API_KEY: apiKey, STEAM_ID64: steamId, CS2_KNOWN_SHARE_CODE: knownCode, CS2_GAME_AUTH_CODE: gameAuth });
      for (const [field, value] of [['steamProfile', profileInput], ['apiKey', clean(body.apiKey)], ['knownCode', knownCode], ['gameAuth', clean(body.gameAuth)]]) {
        await rememberCredential(field, value);
      }
      return send(response, 200, await statusPayload());
    }
    if (request.method === 'POST' && url.pathname === '/api/sync') return send(response, 200, await syncShareCodes());
    return send(response, 404, { error: 'Not found.' });
  } catch (error) {
    return send(response, 500, { error: error instanceof Error ? error.message : 'Unexpected local service error.' });
  }
});

// steam-user throws from inside its own async handlers, outside any promise this
// service can await, so an expired or rejected Steam session used to kill the
// whole process and take the archive API down with it. Serving the archive is
// the primary job; a broken Steam link is reported through status instead.
function surviveSteamFault(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${label}: ${error instanceof Error ? error.stack : message}`);
  setSteamState('error', `Steam connection failed: ${message}`, '');
  try { steamUser?.removeAllListeners(); steamUser?.logOff(); } catch {}
  steamUser = null;
  csgo = null;
  gcReadyPromise = null;
}

void livePublishEnabled().then((enabled) => { if (enabled) startLiveSync(); });

process.on('uncaughtException', (error) => surviveSteamFault('Unhandled exception (service kept running)', error));
process.on('unhandledRejection', (reason) => surviveSteamFault('Unhandled rejection (service kept running)', reason));

server.listen(port, '127.0.0.1', () => console.log(`Stackline local service: http://127.0.0.1:${port}`));
if (existsSync(tokenPath)) readFile(tokenPath, 'utf8').then((token) => connectSteam(clean(token))).catch((error) => setSteamState('error', `Saved Steam session failed: ${error.message}`, ''));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { steamUser?.gamesPlayed([], true); steamUser?.logOff(); } catch {}
    db.close();
    server.close(() => process.exit(0));
  });
}
