'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ServiceStatus = {
  online: boolean;
  credentials: { gameAuth: boolean; apiKey: boolean; steamId: boolean; knownCode: boolean };
  steamId64: string;
  archiveRevision?: string;
  discoveredCodes: number;
  analyzedMatches: number;
  playerCount: number;
  steam: { status: string; message: string; hasSavedSession: boolean; qrDataUrl: string };
  importing: { running: boolean; total: number; processed: number; imported: number; failed: number; message: string };
  maps: { running: boolean; total: number; processed: number; resolved: number; failed: number; message: string };
  backfill?: { running: boolean; target: number; pages: number; seen: number; imported: number; skipped: number; failed: number; message: string };
};
type Match = { id: string; shareCode: string; playedAt: string; map: string; durationSeconds: number; rounds: number; teamAScore: number; teamBScore: number; userTeam: number | null; result: string };
type Player = { accountId: number; steamId64: string; name: string; avatarUrl: string };
type PlayerMatch = { matchId: string; accountId: number; team: number; kills: number; deaths: number; assists: number; headshots: number; mvps: number; score: number; rating: number };
type PublishedInfo = { publishedAt: string; selectedPlayerIds: number[]; ownerSteamId64: string; matchCount: number };
type Archive = { matches: Match[]; players: Player[]; stats: PlayerMatch[]; published?: PublishedInfo | null };
type Lineup = { id: string; name: string; playerIds: number[]; savedAt: string };

const emptyArchive: Archive = { matches: [], players: [], stats: [] };

const selectionStorageKey = 'stackline.lineup.selection';

// The working lineup belongs to this browser, so it is restored on reload instead
// of being reseeded from the published snapshot on every poll.
function readStoredSelection(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(selectionStorageKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function writeStoredSelection(selected: number[]) {
  try { window.localStorage.setItem(selectionStorageKey, JSON.stringify(selected)); } catch {}
}

function withOwner(playerIds: number[], ownerAccountId: number | null) {
  const unique = [...new Set(playerIds.map(Number).filter(Number.isInteger))];
  if (ownerAccountId === null) return unique.slice(0, 5);
  return [ownerAccountId, ...unique.filter((id) => id !== ownerAccountId)].slice(0, 5);
}

function isViewerLocation() {
  if (typeof window === 'undefined') return false;
  return window.location.port === '3001' || new URLSearchParams(window.location.search).get('viewer') === '1';
}

function apiUrl(path: string) {
  if (isViewerLocation()) return `${window.location.origin}${path}`;
  return `http://127.0.0.1:4300${path}`;
}

async function loadStatus(): Promise<ServiceStatus> {
  const response = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Local service unavailable.');
  return response.json();
}

async function loadArchive(): Promise<Archive> {
  const response = await fetch(apiUrl('/api/archive'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read the local archive.');
  return response.json();
}

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function playerColor(accountId: number) {
  const colors = ['#d8ff53', '#7dd3fc', '#f9a8d4', '#c4b5fd', '#fdba74', '#86efac'];
  return colors[Math.abs(accountId) % colors.length];
}

function PlayerAvatar({ player, className = '' }: { player: Player; className?: string }) {
  const picture = player.avatarUrl.replace(/["'()\\]/g, (character) => encodeURIComponent(character));
  return <span className={`player-avatar ${className}`} role="img" aria-label={`${player.name} profile picture`} style={{ backgroundColor: playerColor(player.accountId) }}><span className="avatar-fallback">{initials(player.name)}</span>{picture && <span className="avatar-photo" style={{ backgroundImage: `url("${picture}")` }} />}</span>;
}

export default function Home() {
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [archive, setArchive] = useState<Archive>(emptyArchive);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [steamOpen, setSteamOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillTarget, setBackfillTarget] = useState(250);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [steamProfile, setSteamProfile] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [knownCode, setKnownCode] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [viewerMode, setViewerMode] = useState(false);
  const [lineups, setLineups] = useState<Lineup[]>([]);
  const [lineupName, setLineupName] = useState('');
  const [savingLineup, setSavingLineup] = useState(false);
  const [ledgerLimit, setLedgerLimit] = useState(100);
  const [view, setView] = useState<'overview' | 'played-with'>('overview');
  const mapsRequested = useRef(false);
  const selectionSeeded = useRef(false);
  const archiveRevision = useRef('');
  const archiveFetchedAt = useRef(0);
  const serviceSignature = useRef('');

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await loadStatus();
      // Re-rendering on an identical status is pure cost, and this polls every 1.5s
      // while an import or backfill is running.
      const nextSignature = JSON.stringify(nextStatus);
      if (nextSignature !== serviceSignature.current) {
        serviceSignature.current = nextSignature;
        setService(nextStatus);
        setBackfillTarget((current) => Math.max(current, nextStatus.analyzedMatches));
      }
      // The archive is ~1.5 MB. Only pull it when the service says it actually
      // changed, and at most once every 8s so a running backfill cannot swamp
      // the main thread with re-renders.
      const revision = nextStatus.archiveRevision ?? '';
      const busy = nextStatus.importing.running || nextStatus.maps?.running || nextStatus.backfill?.running;
      const elapsed = Date.now() - archiveFetchedAt.current;
      const stale = revision !== archiveRevision.current;
      if (nextStatus.analyzedMatches && (!archiveFetchedAt.current || (stale && (!busy || elapsed > 8000)))) {
        archiveRevision.current = revision;
        archiveFetchedAt.current = Date.now();
        const nextArchive = await loadArchive();
        setArchive(nextArchive);
        const owner = nextArchive.players.find((player) => player.steamId64 === nextStatus.steamId64);
        const ownerId = owner?.accountId ?? null;
        if (isViewerLocation()) {
          // The viewer mirrors the published snapshot and has nothing to preserve.
          if (nextArchive.published?.selectedPlayerIds?.length) setSelected(nextArchive.published.selectedPlayerIds);
          return;
        }
        if (selectionSeeded.current) {
          // Polling must never overwrite a lineup the user is editing right now.
          if (ownerId !== null) setSelected((current) => (current.includes(ownerId) ? current : withOwner(current, ownerId)));
          return;
        }
        selectionSeeded.current = true;
        setSelected(withOwner(readStoredSelection(), ownerId));
      }
    } catch {
      serviceSignature.current = '';
      setService(null);
    }
  }, []);

  const refreshLineups = useCallback(async () => {
    if (isViewerLocation()) return;
    try {
      const response = await fetch(apiUrl('/api/lineups'), { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { lineups?: Lineup[] };
      setLineups(Array.isArray(payload.lineups) ? payload.lineups : []);
    } catch {}
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { void refreshLineups(); }, 0);
    return () => window.clearTimeout(initial);
  }, [refreshLineups]);
  useEffect(() => {
    if (viewerMode || !selectionSeeded.current) return;
    writeStoredSelection(selected);
  }, [selected, viewerMode]);

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);
  useEffect(() => {
    const syncLocation = () => {
      const isViewer = isViewerLocation();
      setViewerMode(isViewer);
      setView(isViewer || ['#played-with', '#matches', '#players'].includes(window.location.hash) ? 'played-with' : 'overview');
    };
    syncLocation();
    window.addEventListener('hashchange', syncLocation);
    return () => window.removeEventListener('hashchange', syncLocation);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, service?.importing.running || service?.maps?.running || service?.backfill?.running || steamOpen ? 1500 : 5000);
    return () => window.clearInterval(timer);
  }, [refresh, service?.importing.running, service?.maps?.running, service?.backfill?.running, steamOpen]);

  useEffect(() => {
    if (mapsRequested.current || !archive.matches.some((match) => match.map === 'Unknown map')) return;
    mapsRequested.current = true;
    if (!viewerMode) void fetch(apiUrl('/api/maps'), { method: 'POST' }).then(() => refresh()).catch(() => {});
  }, [archive.matches, refresh, viewerMode]);

  const credentialCount = service ? Object.values(service.credentials).filter(Boolean).length : 0;
  const readyToSync = credentialCount === 4;
  const steamConnected = service?.steam.status === 'connected';
  const steamReady = steamConnected || service?.steam.status === 'ready' || Boolean(service?.steam.hasSavedSession);

  const statsByMatch = useMemo(() => {
    const map = new Map<string, PlayerMatch[]>();
    for (const row of archive.stats) map.set(row.matchId, [...(map.get(row.matchId) ?? []), row]);
    return map;
  }, [archive.stats]);
  const playerById = useMemo(() => new Map(archive.players.map((player) => [player.accountId, player])), [archive.players]);
  const statsByAccount = useMemo(() => {
    const map = new Map<number, PlayerMatch[]>();
    for (const row of archive.stats) {
      const rows = map.get(row.accountId);
      if (rows) rows.push(row);
      else map.set(row.accountId, [row]);
    }
    return map;
  }, [archive.stats]);
  const ownerPlayer = service?.steamId64 ? archive.players.find((player) => player.steamId64 === service.steamId64) ?? null : null;
  const ownerAccountId = ownerPlayer?.accountId ?? null;
  const filteredMatches = useMemo(() => {
    if (selected.length < 2) return archive.matches;
    return archive.matches.filter((match) => {
      const ids = new Set((statsByMatch.get(match.id) ?? []).map((row) => row.accountId));
      return selected.every((id) => ids.has(id));
    });
  }, [archive.matches, selected, statsByMatch]);
  const visibleStats = useMemo(() => {
    const matchIds = new Set(filteredMatches.map((match) => match.id));
    const ids = selected.length ? selected : archive.players.map((player) => player.accountId);
    return ids.map((accountId) => {
      const rows = (statsByAccount.get(accountId) ?? []).filter((row) => matchIds.has(row.matchId));
      const totals = rows.reduce((sum, row) => ({ kills: sum.kills + row.kills, deaths: sum.deaths + row.deaths, assists: sum.assists + row.assists, headshots: sum.headshots + row.headshots, rating: sum.rating + row.rating }), { kills: 0, deaths: 0, assists: 0, headshots: 0, rating: 0 });
      const placements = [0, 0, 0, 0, 0];
      let placementTotal = 0;
      for (const row of rows) {
        const teamRows = (statsByMatch.get(row.matchId) ?? []).filter((candidate) => candidate.team === row.team).sort((a, b) => b.score - a.score || b.rating - a.rating || b.kills - a.kills || a.accountId - b.accountId);
        const placement = teamRows.findIndex((candidate) => candidate.accountId === accountId) + 1;
        if (placement >= 1 && placement <= 5) {
          placements[placement - 1] += 1;
          placementTotal += placement;
        }
      }
      return { player: playerById.get(accountId), matches: rows.length, ...totals, placements, averagePlacement: rows.length ? placementTotal / rows.length : 0, rating: rows.length ? totals.rating / rows.length : 0 };
    }).filter((row) => row.player && row.matches).sort((a, b) => b.matches - a.matches || b.rating - a.rating).slice(0, selected.length ? 5 : 6);
  }, [archive.players, filteredMatches, playerById, selected, statsByAccount, statsByMatch]);
  const availablePlayers = useMemo(() => archive.players.filter((player) => !selected.includes(player.accountId) && player.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8), [archive.players, search, selected]);
  const ledgerMatches = useMemo(() => filteredMatches.slice(0, ledgerLimit), [filteredMatches, ledgerLimit]);
  const lineupSuggestion = useMemo(() => selected.filter((id) => id !== ownerAccountId).map((id) => playerById.get(id)?.name).filter(Boolean).join(' + '), [ownerAccountId, playerById, selected]);
  const firstPlaceFinishes = visibleStats.reduce((sum, row) => sum + row.placements[0], 0);
  const bestAveragePlacement = visibleStats.length ? Math.min(...visibleStats.map((row) => row.averagePlacement)) : 0;
  const activeMatch = selectedMatchId ? archive.matches.find((match) => match.id === selectedMatchId) ?? null : null;
  const activeMatchRows = activeMatch ? [...(statsByMatch.get(activeMatch.id) ?? [])].sort((a, b) => a.team - b.team || b.rating - a.rating) : [];
  const activeFriendlyTeam = activeMatch?.userTeam ?? 0;
  const activeTeamOrder = [activeFriendlyTeam, activeFriendlyTeam === 0 ? 1 : 0];
  const activeTeamSummaries = activeTeamOrder.map((team) => {
    const rows = activeMatchRows.filter((row) => row.team === team);
    const kills = rows.reduce((sum, row) => sum + row.kills, 0);
    const deaths = rows.reduce((sum, row) => sum + row.deaths, 0);
    const assists = rows.reduce((sum, row) => sum + row.assists, 0);
    const headshots = rows.reduce((sum, row) => sum + row.headshots, 0);
    const rating = rows.reduce((sum, row) => sum + row.rating, 0);
    return { team, kills, deaths, assists, kd: deaths ? kills / deaths : 0, hs: kills ? (headshots / kills) * 100 : 0, rating: rows.length ? rating / rows.length : 0 };
  });
  const activePlayer = selectedPlayerId === null ? null : playerById.get(selectedPlayerId) ?? null;
  const activePlayerSummary = useMemo(() => {
    if (selectedPlayerId === null) return null;
    const rows = statsByAccount.get(selectedPlayerId) ?? [];
    const totals = rows.reduce((sum, row) => ({ kills: sum.kills + row.kills, deaths: sum.deaths + row.deaths, assists: sum.assists + row.assists, headshots: sum.headshots + row.headshots, rating: sum.rating + row.rating }), { kills: 0, deaths: 0, assists: 0, headshots: 0, rating: 0 });
    return { ...totals, matches: rows.length, rating: rows.length ? totals.rating / rows.length : 0 };
  }, [selectedPlayerId, statsByAccount]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await fetch(apiUrl('/api/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steamProfile, apiKey, knownCode }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save Steam settings.');
      setService(payload); setSettingsOpen(false); setApiKey(''); setKnownCode('');
      setNotice('Valve connection saved.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save Steam settings.'); }
    finally { setSaving(false); }
  }

  async function syncMatches() {
    if (!readyToSync) { setSettingsOpen(true); return; }
    setSyncing(true); setNotice('');
    try {
      const response = await fetch(apiUrl('/api/sync'), { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Sync failed.');
      setNotice(payload.message);
      if (steamConnected) await fetch(apiUrl('/api/analyze'), { method: 'POST' });
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Sync failed.'); }
    finally { await refresh(); setSyncing(false); }
  }

  async function connectSteam() {
    setSteamOpen(true); setConnecting(true); setError('');
    try {
      const response = await fetch(apiUrl('/api/steam/qr'), { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not start Steam approval.');
      setService(payload);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not start Steam approval.'); }
    finally { setConnecting(false); }
  }

  async function analyzeMatches() {
    if (!steamConnected) { await connectSteam(); return; }
    await fetch(apiUrl('/api/analyze'), { method: 'POST' });
    setNotice('Valve scoreboard import started.');
    await refresh();
  }

  async function publishViewer() {
    if (viewerMode || selected.length < 2) return;
    setPublishing(true); setNotice('');
    try {
      const response = await fetch(apiUrl('/api/publish'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedPlayerIds: selected }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not publish the viewer snapshot.');
      setNotice(`Published ${payload.published.matchCount} shared matches to the view-only page.`);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Could not publish the viewer snapshot.'); }
    finally { setPublishing(false); }
  }

  async function backfillHistory() {
    if (viewerMode || service?.backfill?.running) return;
    setBackfilling(true); setNotice('Starting older Premier history backfill…');
    try {
      const response = await fetch(apiUrl('/api/backfill'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetMatches: backfillTarget }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not start history backfill.');
      setService(payload);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Could not start history backfill.'); }
    finally { setBackfilling(false); }
  }

  async function saveLineup() {
    if (viewerMode || selected.length < 2) return;
    const name = lineupName.trim() || lineupSuggestion;
    setSavingLineup(true); setNotice('');
    try {
      const response = await fetch(apiUrl('/api/lineups'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, playerIds: selected }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save this lineup.');
      setLineups(payload.lineups); setLineupName('');
      setNotice(`Saved the "${name}" lineup.`);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Could not save this lineup.'); }
    finally { setSavingLineup(false); }
  }

  async function removeLineup(lineup: Lineup) {
    if (viewerMode) return;
    setNotice('');
    try {
      const response = await fetch(apiUrl('/api/lineups/delete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lineup.id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not delete this lineup.');
      setLineups(payload.lineups);
      setNotice(`Deleted the "${lineup.name}" lineup.`);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Could not delete this lineup.'); }
  }

  function applyLineup(lineup: Lineup) {
    if (viewerMode) return;
    setSelected(withOwner(lineup.playerIds, ownerAccountId));
    setSearch('');
    setSelectedMatchId(null);
  }

  function addPlayer(accountId: number) {
    if (selected.length < 5 && accountId !== ownerAccountId) setSelected((current) => [...current, accountId]);
    setSearch('');
  }

  function toggleLineupPlayer(accountId: number) {
    if (viewerMode || accountId === ownerAccountId) return;
    setSelected((current) => current.includes(accountId) ? current.filter((id) => id !== accountId) : current.length < 5 ? [...current, accountId] : current);
  }

  return (
    <main className={viewerMode ? 'app-shell viewer-mode' : 'app-shell'}>
      <header className="topbar">
        <a className="brand" href={viewerMode ? '#played-with' : '#overview'} aria-label="Stackline home"><span className="brand-mark"><i /><i /><i /></span><span>STACKLINE</span></a>
        <div className="archive-state"><span className={service ? 'pulse' : 'pulse offline'} /><span><strong>{viewerMode ? 'Live read-only archive' : 'Local archive'}</strong><small>{service ? `${service.analyzedMatches} analyzed · ${service.playerCount} players` : 'Local service offline'}</small></span></div>
        {viewerMode ? <span className="viewer-badge">VIEW ONLY</span> : <button className="sync-button" type="button" onClick={syncMatches} disabled={syncing}><span className={syncing ? 'spin' : ''}>↻</span>{syncing ? 'Syncing safely…' : 'Sync matches'}</button>}
      </header>

      <div className="dashboard" id="top">
        <aside className="sidebar">
          <div><p className="eyebrow">Navigation</p><nav aria-label="Main navigation">{!viewerMode && <a className={view === 'overview' ? 'nav-item active' : 'nav-item'} href="#overview"><span>⌁</span>Overview</a>}<a className={view === 'played-with' ? 'nav-item active' : 'nav-item'} href="#played-with"><span>◉</span>Played with</a>{!viewerMode && <a className="nav-item" href="http://localhost:3001/#played-with" target="_blank" rel="noreferrer"><span>↗</span>View-only page</a>}</nav></div>
          {!viewerMode && <div className="connection-card"><span className="connection-icon">S</span><div><strong>{steamReady ? 'Steam approved' : 'Steam setup'}</strong><p>{steamConnected ? 'Game Coordinator connected' : steamReady ? 'Saved local session' : `${credentialCount} of 4 keys saved`}</p></div><button type="button" aria-label="Open Steam settings" onClick={() => setSettingsOpen(true)}>›</button></div>}
        </aside>

        <section className="content" id={view}>
          <div className="hero-row"><div><p className="eyebrow accent">{viewerMode ? 'Shared Premier archive' : view === 'played-with' ? 'Lineup intelligence' : 'Premier match intelligence'}</p><h1>{view === 'played-with' ? 'Who played with you?' : 'Your real match archive.'}</h1><p className="lede">{view === 'played-with' ? `${ownerPlayer?.name ?? 'Your Steam player'} stays selected. Add one to four players to recalculate every match and statistic where everyone was present.` : 'Your authenticated Valve history, player profiles, match scoreboards, and map data are stored locally and ready to explore.'}</p></div><div className="scope-pill"><span>●</span>{viewerMode ? ' Live · Read only' : ' Valve Premier · Local only'}</div></div>
          {notice && <button className="notice" type="button" onClick={() => setNotice('')}><span>i</span>{notice}<b>×</b></button>}

          {!viewerMode && view === 'overview' && <section className="pipeline-card" aria-labelledby="pipeline-title">
            <div className="filter-heading"><div><p className="eyebrow" id="pipeline-title">Archive pipeline</p><h2>Connection progress</h2></div><p className="selection-rule">Everything is saved locally</p></div>
            <div className="pipeline-grid">
              <div className={readyToSync ? 'pipeline-step complete' : 'pipeline-step'}><span>01</span><div><small>Valve credentials</small><strong>{readyToSync ? 'Connected' : `${credentialCount} of 4 saved`}</strong></div><b>{readyToSync ? '✓' : '·'}</b></div>
              <div className={service?.analyzedMatches ? 'pipeline-step complete' : 'pipeline-step'}><span>02</span><div><small>Premier history</small><strong>{service?.backfill?.running ? `${service.backfill.seen} scanned · ${service.backfill.imported} older imported` : `${service?.analyzedMatches ?? 0} matches archived`}</strong></div><b>{service?.backfill?.running ? '↻' : '✓'}</b></div>
              <button className={steamReady ? 'pipeline-step complete pipeline-action' : 'pipeline-step pipeline-action'} type="button" onClick={connectSteam}><span>03</span><div><small>Steam client</small><strong>{steamConnected ? 'Game Coordinator connected' : steamReady ? 'Approval saved locally' : 'Approve once with QR'}</strong></div><b>{steamReady ? '✓' : '→'}</b></button>
              <button className={service?.analyzedMatches ? 'pipeline-step complete pipeline-action' : 'pipeline-step pipeline-action'} type="button" onClick={analyzeMatches}><span>04</span><div><small>Analyzed archive</small><strong>{service?.importing.running ? `${service.importing.processed} / ${service.importing.total} processing` : `${service?.analyzedMatches ?? 0} matches analyzed`}</strong></div><b>{service?.analyzedMatches ? '✓' : '→'}</b></button>
            </div>
            <div className="backfill-controls"><div><span>Older history target</span><small>Choose the total number of matches to try loading. If Steam has fewer, Stackline keeps everything available and reports the actual total.</small></div><label><input type="number" min={service?.analyzedMatches ?? 1} max="5000" step="25" value={backfillTarget} disabled={service?.backfill?.running} onChange={(event) => setBackfillTarget(Math.max(1, Number(event.target.value) || 1))} /><span>matches</span></label><button type="button" onClick={backfillHistory} disabled={backfilling || service?.backfill?.running}>{service?.backfill?.running ? 'Loading older matches…' : 'Load older history'}</button></div>
            {service?.importing.running && <div className="progress-track"><i style={{ width: `${service.importing.total ? (service.importing.processed / service.importing.total) * 100 : 0}%` }} /></div>}
            {service?.backfill?.running && <div className="backfill-status">{service.backfill.message}</div>}
          </section>}

          {view === 'overview' && <a className="played-with-cta" href="#played-with"><span>◉</span><div><p className="eyebrow accent">Played with</p><h2>Build a lineup and compare shared matches</h2><small>{ownerPlayer?.name ?? 'Your Steam player'} is always included as the archive owner.</small></div><b>Open →</b></a>}

          {view === 'played-with' && <>{archive.players.length > 0 && <section className="filter-card" id="players">
            <div className="filter-heading"><div><p className="eyebrow">{viewerMode ? 'Published lineup' : 'Lineup filter'}</p><h2>{viewerMode ? 'Last published comparison' : 'Who played together?'}</h2></div>{viewerMode ? <p className="selection-rule">{archive.published ? `Published ${new Date(archive.published.publishedAt).toLocaleString()}` : 'Nothing published yet'}</p> : <button className="publish-button" type="button" disabled={publishing || selected.length < 2} onClick={publishViewer}>{publishing ? 'Publishing…' : 'Publish to view-only page ↗'}</button>}</div>
            {!viewerMode && <div className="lineup-presets">
              <div className="preset-list">
                <p className="eyebrow">Saved lineups</p>
                {lineups.length ? <div className="preset-chips">{lineups.map((lineup) => {
                  const applied = lineup.playerIds.length === selected.length && lineup.playerIds.every((id) => selected.includes(id));
                  return <span key={lineup.id} className={applied ? 'preset-chip applied' : 'preset-chip'}>
                    <button type="button" onClick={() => applyLineup(lineup)} title={lineup.playerIds.map((id) => playerById.get(id)?.name ?? id).join(' + ')}>{lineup.name}<i>{lineup.playerIds.length}</i></button>
                    <button type="button" className="preset-remove" aria-label={`Delete the ${lineup.name} lineup`} onClick={() => removeLineup(lineup)}>×</button>
                  </span>;
                })}</div> : <p className="selection-rule">Pick two to five players below, then save the lineup to reapply it in one click.</p>}
              </div>
              <div className="preset-save">
                <input value={lineupName} onChange={(event) => setLineupName(event.target.value)} maxLength={60} placeholder={lineupSuggestion || 'Lineup name…'} aria-label="Lineup name" />
                <button type="button" disabled={savingLineup || selected.length < 2} onClick={saveLineup}>{savingLineup ? 'Saving…' : 'Save lineup'}</button>
              </div>
            </div>}
            <div className="player-picker">
              {selected.map((id) => { const player = playerById.get(id); const isOwner = id === ownerAccountId; return player && <button key={id} className={`${isOwner ? 'player-chip owner-chip' : 'player-chip'}${viewerMode ? ' readonly-chip' : ''}`} type="button" disabled={viewerMode || isOwner} onClick={() => setSelected((current) => current.filter((value) => value !== id))}><PlayerAvatar player={player} className="chip-avatar" />{player.name}<b>{viewerMode ? 'PUBLISHED' : isOwner ? 'PINNED' : '×'}</b></button>; })}
              {!viewerMode && selected.length < 5 && <div className="search-player"><b>＋</b><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={selected.length ? 'Add player…' : 'Search players…'} /></div>}
              {!viewerMode && search && <div className="search-results">{availablePlayers.map((player) => <button key={player.accountId} type="button" onClick={() => addPlayer(player.accountId)}><PlayerAvatar player={player} className="search-avatar" />{player.name}</button>)}</div>}
            </div>
            <div className="filter-summary"><div><strong>{selected.length < 2 ? '—' : filteredMatches.length}</strong><span>Matches together</span></div><div><strong>{selected.length || '—'}</strong><span>Players selected</span></div><div><strong>{selected.length < 2 ? '—' : firstPlaceFinishes}</strong><span>First-place finishes</span></div><div><strong>{selected.length < 2 ? '—' : bestAveragePlacement.toFixed(2)}</strong><span>Best average place</span></div></div>
          </section>}

          <section className="performance">
            <div className="section-heading"><div><p className="eyebrow">Adjusted performance</p><h2>{selected.length >= 2 ? `Across ${filteredMatches.length} shared matches` : 'Players in your archive'}</h2></div><span>{selected.length < 2 ? 'Select at least two to filter' : 'Only shared matches included'}</span></div>
            {visibleStats.length ? <div className="stat-grid">{visibleStats.map((row) => {
              const player = row.player!; const differential = row.kills - row.deaths;
              return <button className="player-stat-card" type="button" key={player.accountId} onClick={() => setSelectedPlayerId(player.accountId)}>
                <div className="player-title"><PlayerAvatar player={player} className="card-avatar" /><div><h3>{player.name}</h3><p>{row.matches} match{row.matches === 1 ? '' : 'es'} in view</p></div><strong>{row.rating.toFixed(2)}</strong></div>
                <div className="stat-line"><span><small>K / D</small><b>{row.kills} / {row.deaths}</b></span><span><small>DIFF</small><b className={differential >= 0 ? 'positive' : 'negative'}>{differential >= 0 ? '+' : ''}{differential}</b></span><span><small>HS%</small><b>{row.kills ? Math.round((row.headshots / row.kills) * 100) : 0}%</b></span></div>
                <div className="placement-heading"><span>Team placement finishes</span><strong>AVG {row.averagePlacement.toFixed(2)}</strong></div>
                <div className="placement-grid">{row.placements.map((count, index) => <span key={index}><small>{index + 1}{index === 0 ? 'ST' : index === 1 ? 'ND' : index === 2 ? 'RD' : 'TH'}</small><b>{count}</b></span>)}</div>
                <div className="mini-metrics"><span><small>K/D</small>{row.deaths ? (row.kills / row.deaths).toFixed(2) : row.kills.toFixed(2)}</span><span><small>ASSISTS</small>{row.assists}</span><span><small>RATING</small>{row.rating.toFixed(2)}</span></div>
              </button>;
            })}</div> : <div className="empty-state"><span className="empty-icon">◉</span><div><h3>{service?.discoveredCodes ? 'One Steam approval unlocks the scoreboards' : 'No matches discovered yet'}</h3><p>{service?.discoveredCodes ? 'Click step 03, scan the QR code in Steam Mobile, and approve. Stackline will import the real players and match stats automatically.' : 'Press Sync matches to discover your Valve history.'}</p>{service?.discoveredCodes ? <button className="inline-action" type="button" onClick={connectSteam}>Connect Steam & analyze</button> : null}</div></div>}
          </section>

          <section className="matches-section" id="matches">
            <div className="section-heading"><div><p className="eyebrow">Match ledger</p><h2>Played together</h2></div><span>{service?.maps?.running ? `Resolving maps ${service.maps.processed} / ${service.maps.total}` : `${filteredMatches.length} real match${filteredMatches.length === 1 ? '' : 'es'}`}</span></div>
            <div className="match-table"><div className="match-row match-head"><span>Match</span><span>Players</span><span>Score</span><span>Friendly team</span><span /></div>{filteredMatches.length ? ledgerMatches.map((match) => {
              const rows = statsByMatch.get(match.id) ?? [];
              const friendlyRows = [...rows].filter((row) => row.team === match.userTeam).sort((a, b) => b.score - a.score || b.rating - a.rating);
              return <button className={`match-row ${match.result === 'win' ? 'match-win' : match.result === 'loss' ? 'match-loss' : ''}`} type="button" key={match.id} onClick={() => setSelectedMatchId(match.id)}>
                <div className="map-cell"><i className={`result ${match.result === 'win' ? 'w' : match.result === 'loss' ? 'l' : ''}`}>{match.result === 'win' ? 'W' : match.result === 'loss' ? 'L' : 'D'}</i><span><strong>{match.map.replace(/^de_/, '').replace(/^./, (letter) => letter.toUpperCase())}</strong><small>{new Date(match.playedAt).toLocaleDateString()}</small></span></div>
                <div className="avatar-stack">{rows.slice(0, 5).map((row) => { const player = playerById.get(row.accountId); return player ? <PlayerAvatar key={row.accountId} player={player} className="stack-avatar" /> : null; })}</div>
                <div className="score-cell"><strong className={match.result === 'win' ? 'score-win' : match.result === 'loss' ? 'score-loss' : ''}>{match.teamAScore} : {match.teamBScore}</strong><small>{match.rounds} rounds</small></div>
                <div className="friendly-lineup">{friendlyRows.map((row, index) => { const player = playerById.get(row.accountId); const hs = row.kills ? Math.round((row.headshots / row.kills) * 100) : 0; return player ? <span className={row.accountId === ownerAccountId ? 'friendly-owner' : ''} key={row.accountId} title={`${index + 1}. ${player.name} · ${row.score} score`}><em>{index + 1}</em><PlayerAvatar player={player} className="friendly-avatar" /><span><b>{player.name}{row.accountId === ownerAccountId ? ' · YOU' : ''}</b><small>K/D {row.kills}/{row.deaths} · R {row.rating.toFixed(2)} · HS {hs}%</small></span></span> : null; })}</div>
                <span className="row-arrow">›</span>
              </button>;
            }) : <div className="table-empty"><strong>No matching analyzed matches</strong><p>{selected.length >= 2 ? 'Those selected players have not appeared together in the imported archive.' : `${service?.discoveredCodes ?? 0} match codes are stored and ready for Steam analysis.`}</p></div>}</div>
            {filteredMatches.length > ledgerMatches.length && <button className="ledger-more" type="button" onClick={() => setLedgerLimit((current) => current + 100)}>Show 100 more<small>{ledgerMatches.length} of {filteredMatches.length} shown</small></button>}
          </section>
          {archive.matches.length > 0 && <p className="rating-note">Rating index is a transparent scoreboard-based approximation normalized around 1.00 using kills per round, survival, and assists. It is not the proprietary HLTV Rating 2.0 formula.</p>}</>}
        </section>
      </div>

      {activeMatch && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedMatchId(null); }}>
        <section className="settings-modal detail-modal" role="dialog" aria-modal="true" aria-labelledby="match-detail-title">
          <button className="modal-close" type="button" onClick={() => setSelectedMatchId(null)} aria-label="Close match details">×</button>
          <p className="eyebrow accent">Premier match details</p>
          <div className="match-detail-hero"><div><h2 id="match-detail-title">{activeMatch.map.replace(/^de_/, '').replace(/^./, (letter) => letter.toUpperCase())}</h2><p>{new Date(activeMatch.playedAt).toLocaleString()} · {activeMatch.rounds} rounds</p></div><strong className={activeMatch.result === 'win' ? 'score-win' : activeMatch.result === 'loss' ? 'score-loss' : ''}>{activeMatch.teamAScore}<i>:</i>{activeMatch.teamBScore}</strong></div>
          <div className="team-comparison">{activeTeamSummaries.map((summary, index) => <div className={index === 0 ? 'your-team' : ''} key={summary.team}><span>{index === 0 ? 'Friendly team' : 'Enemy team'}</span><strong>{summary.rating.toFixed(2)}</strong><small>AVG RATING</small><b>{summary.kd.toFixed(2)} K/D · {Math.round(summary.hs)}% HS</b><em>{summary.kills} K · {summary.deaths} D · {summary.assists} A</em></div>)}</div>
          <div className="comparison-title"><div><p className="eyebrow">Separated scoreboards</p><h3>Friendly five vs enemy five</h3></div><span>Click a player for archive stats</span></div>
          <div className="split-scoreboards">{activeTeamOrder.map((team, teamIndex) => {
            const teamScore = team === 0 ? activeMatch.teamAScore : activeMatch.teamBScore;
            const teamRows = activeMatchRows.filter((row) => row.team === team).sort((a, b) => b.score - a.score || b.rating - a.rating);
            return <section className={teamIndex === 0 ? 'team-board friendly-board' : 'team-board enemy-board'} key={team}>
              <div className="team-board-title"><div><p>{teamIndex === 0 ? 'FRIENDLY TEAM' : 'ENEMY TEAM'}</p><span>{teamRows.length} players · scoreboard order</span></div><strong>{teamScore}</strong></div>
              <div className="scoreboard-team split-scoreboard"><div className="scoreboard-head"><strong>Player</strong><span>K</span><span>D</span><span>+/−</span><span>A</span><span>HS%</span><span>Rating</span></div>{teamRows.map((row, index) => { const player = playerById.get(row.accountId); if (!player) return null; const difference = row.kills - row.deaths; return <button className={`scoreboard-row ${index === 0 ? 'comparison-leader' : ''}`} type="button" key={row.accountId} onClick={() => setSelectedPlayerId(row.accountId)}><span className="scoreboard-player"><PlayerAvatar player={player} className="score-avatar" /><b>{player.name}</b></span><span>{row.kills}</span><span>{row.deaths}</span><strong className={difference > 0 ? 'positive' : difference < 0 ? 'negative' : ''}>{difference > 0 ? '+' : ''}{difference}</strong><span>{row.assists}</span><span>{row.kills ? Math.round((row.headshots / row.kills) * 100) : 0}%</span><strong>{row.rating.toFixed(2)}</strong></button>; })}</div>
            </section>;
          })}</div>
        </section>
      </div>}

      {activePlayer && activePlayerSummary && <div className="modal-backdrop player-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedPlayerId(null); }}><section className="settings-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="player-detail-title"><button className="modal-close" type="button" onClick={() => setSelectedPlayerId(null)} aria-label="Close player details">×</button><div className="player-profile-head"><PlayerAvatar player={activePlayer} className="profile-avatar" /><div><p className="eyebrow accent">Player profile</p><h2 id="player-detail-title">{activePlayer.name}</h2><a href={`https://steamcommunity.com/profiles/${activePlayer.steamId64}`} target="_blank" rel="noreferrer">Open Steam profile ↗</a></div></div><div className="profile-stat-grid"><div><strong>{activePlayerSummary.matches}</strong><span>Matches</span></div><div><strong>{activePlayerSummary.deaths ? (activePlayerSummary.kills / activePlayerSummary.deaths).toFixed(2) : activePlayerSummary.kills.toFixed(2)}</strong><span>K/D</span></div><div><strong className={activePlayerSummary.kills - activePlayerSummary.deaths >= 0 ? 'positive' : 'negative'}>{activePlayerSummary.kills - activePlayerSummary.deaths >= 0 ? '+' : ''}{activePlayerSummary.kills - activePlayerSummary.deaths}</strong><span>Difference</span></div><div><strong>{activePlayerSummary.kills ? Math.round((activePlayerSummary.headshots / activePlayerSummary.kills) * 100) : 0}%</strong><span>HS%</span></div><div><strong>{activePlayerSummary.assists}</strong><span>Assists</span></div><div><strong>{activePlayerSummary.rating.toFixed(2)}</strong><span>Rating</span></div></div><button className="primary-button" type="button" disabled={!selected.includes(activePlayer.accountId) && selected.length >= 5} onClick={() => toggleLineupPlayer(activePlayer.accountId)}>{selected.includes(activePlayer.accountId) ? 'Remove from lineup filter' : selected.length >= 5 ? 'Lineup filter is full' : 'Add to lineup filter'}</button></section></div>}

      {steamOpen && <div className="modal-backdrop" role="presentation"><section className="settings-modal steam-modal" role="dialog" aria-modal="true" aria-labelledby="steam-title"><button className="modal-close" type="button" onClick={() => setSteamOpen(false)} aria-label="Close Steam approval">×</button><p className="eyebrow accent">Steam client approval</p><h2 id="steam-title">Connect the CS2 archive</h2><p className="modal-copy">This authorizes the local service as a Steam client so it can ask Valve for the real scoreboard behind each of your 97 match codes. Your saved session never leaves this computer.</p>{service?.steam.qrDataUrl && !steamConnected ? <div className="steam-qr" role="img" aria-label="Steam mobile sign-in QR code" style={{ backgroundImage: `url(${service.steam.qrDataUrl})` }} /> : <div className={steamConnected ? 'steam-success' : 'qr-loading'}>{steamConnected ? '✓' : '↻'}</div>}<div className="steam-message"><span className={steamConnected ? 'status-dot ready' : 'status-dot'} /><div><strong>{steamConnected ? 'Connected' : connecting ? 'Starting…' : 'Waiting for approval'}</strong><small>{service?.steam.message ?? 'Contacting the local service…'}</small></div></div>{error && <p className="form-error">{error}</p>}{steamConnected && <button className="primary-button" type="button" onClick={() => setSteamOpen(false)}>View live import</button>}<p className="modal-footnote">Open Steam Mobile → scan the QR → approve. You only do this once; Stackline stores a refresh token in its ignored local data folder.</p></section></div>}

      {settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="modal-close" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button><p className="eyebrow accent">Local connection</p><h2 id="settings-title">Connect Valve match history</h2><p className="modal-copy">These values stay in the ignored local secret file. Stackline never displays saved secrets back to the browser.</p><div className="saved-secret"><span className={service?.credentials.gameAuth ? 'status-dot ready' : 'status-dot'} /><div><strong>Game Authentication Code</strong><small>{service?.credentials.gameAuth ? 'Saved locally' : 'Missing'}</small></div><b>{service?.credentials.gameAuth ? '•••• ••••• ••••' : '—'}</b></div>{readyToSync && <div className="connected-banner"><span>✓</span><div><strong>Valve connection configured</strong><small>SteamID64 {service?.steamId64}</small></div></div>}<form onSubmit={saveSettings}><label><span>Steam profile URL or SteamID64</span><input required value={steamProfile} onChange={(event) => setSteamProfile(event.target.value)} placeholder="https://steamcommunity.com/id/…" autoComplete="off" /></label><label><span>Steam Web API key</span><input required type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Enter API key" autoComplete="off" /></label><label><span>Starting match token</span><input required value={knownCode} onChange={(event) => setKnownCode(event.target.value)} placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" autoComplete="off" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" type="submit" disabled={saving || !service}>{saving ? 'Saving…' : service ? 'Replace connection settings' : 'Start local service first'}</button></form><p className="modal-footnote">You only enter one starting token. Stackline follows the history automatically and preserves its cursor after every discovered match.</p></section></div>}
    </main>
  );
}
