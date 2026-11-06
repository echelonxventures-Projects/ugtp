import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, can, money, when, type Session } from '../api';
import { Badge, Button, ErrorNote, Panel, Table, statusTone, type Row } from '../ui';
import { diceMultiplierBp, isPlayableDiceTarget, payoutFor } from '../../shared/engine';

interface DiceResponse {
  roundId: string;
  roll: number;
  target: number;
  direction: 'under' | 'over';
  won: boolean;
  multiplierBp: number;
  stakeMinor: number;
  payoutMinor: number;
  balanceMinor: number;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

interface WalletRow {
  asset_code: string;
  balance_minor: number;
  monetary: number;
}

export default function Play({ session }: { session: Session }) {
  const [players, setPlayers] = useState<Row[]>([]);
  const [playerId, setPlayerId] = useState<string>(session.playerId ?? '');
  const [wallet, setWallet] = useState<WalletRow[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [asset, setAsset] = useState('XCR');
  const [stake, setStake] = useState('100');
  const [direction, setDirection] = useState<'under' | 'over'>('under');
  const [target, setTarget] = useState(5000);
  const [result, setResult] = useState<DiceResponse | null>(null);
  const [fairness, setFairness] = useState<{ revealed: Row; current: Row } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (session.playerId) return;
    if (!can(session, 'player:read')) return;
    void api<{ players: Row[] }>('/players')
      .then((data) => {
        setPlayers(data.players);
        if (!playerId && data.players.length) setPlayerId(String(data.players[0].id));
      })
      .catch(setError);
  }, [session, playerId]);

  const loadPlayer = useCallback(async () => {
    if (!playerId) return;
    try {
      const [walletData, historyData] = await Promise.all([
        api<{ wallet: WalletRow[] }>(`/players/${playerId}/wallet`),
        api<{ rounds: Row[] }>(`/players/${playerId}/history`),
      ]);
      setWallet(walletData.wallet);
      setHistory(historyData.rounds);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [playerId]);

  useEffect(() => {
    void loadPlayer();
  }, [loadPlayer]);

  const balance = wallet.find((row) => row.asset_code === asset)?.balance_minor ?? 0;
  const stakeMinor = Number(stake) || 0;
  const multiplierBp = useMemo(
    () => (isPlayableDiceTarget(direction, target) ? diceMultiplierBp(direction, target, 100) : 0),
    [direction, target],
  );
  const potential = payoutFor(stakeMinor, multiplierBp);
  const chance = direction === 'under' ? target / 100 : (10000 - target) / 100;

  async function roll() {
    if (!playerId) {
      setError(new Error('Select a player first'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api<DiceResponse>('/play/dice', {
        method: 'POST',
        body: { playerId, stakeMinor, assetCode: asset, direction, target },
      });
      setResult(response);
      await loadPlayer();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!playerId) return;
    setBusy(true);
    try {
      const response = await api<{ revealed: Row; current: Row }>('/play/fairness/rotate', {
        method: 'POST',
        body: { playerId, assetCode: asset },
      });
      setFairness(response);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="hero">
        <div>
          <h2>Provably fair dice</h2>
          <p>
            Outcomes derive from HMAC-SHA256(server seed, client seed, nonce). The server publishes the seed
            hash before play and reveals the seed on rotation. No hidden bias or player-specific steering.
          </p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end' }}>
          <span className="muted small">Balance · {asset}</span>
          <span className="balance-hero">{money(balance)}</span>
        </div>
      </div>

      {error ? (
        <Panel title="Action failed">
          <div className="pad"><ErrorNote error={error} /></div>
        </Panel>
      ) : null}

      <div className="grid cols-2">
        <Panel title="Place a wager" subtitle="Server-authoritative. The stake is debited atomically with the outcome.">
          <div className="pad stack" style={{ gap: 14 }}>
            <div className="row gap wrap">
              {!session.playerId ? (
                <label className="field lg">
                  <span>Player</span>
                  <select value={playerId} onChange={(event) => setPlayerId(event.target.value)}>
                    <option value="">Select player…</option>
                    {players.map((player) => (
                      <option key={String(player.id)} value={String(player.id)}>
                        {String(player.display_name)} · {String(player.jurisdiction_code)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field sm">
                <span>Asset</span>
                <select
                  value={asset}
                  onChange={(event) => {
                    setAsset(event.target.value);
                    setResult(null);
                  }}
                >
                  <option value="XCR">Play credits</option>
                  <option value="USD">Cash (USD)</option>
                </select>
              </label>
              <label className="field md">
                <span>Stake (minor)</span>
                <input type="number" min={1} value={stake} onChange={(event) => setStake(event.target.value)} />
              </label>
              <div className="row gap">
                {[100, 1000, 10000].map((preset) => (
                  <Button key={preset} onClick={() => setStake(String(preset))}>
                    {preset / 100}
                  </Button>
                ))}
              </div>
            </div>

            <div className="row gap wrap" style={{ justifyContent: 'space-between' }}>
              <div className="pill-toggle">
                <button className={direction === 'under' ? 'on' : ''} onClick={() => setDirection('under')}>
                  Roll under
                </button>
                <button className={direction === 'over' ? 'on' : ''} onClick={() => setDirection('over')}>
                  Roll over
                </button>
              </div>
              <span className="muted small">
                target {(target / 100).toFixed(2)} · win chance {chance.toFixed(2)}% · multiplier{' '}
                {(multiplierBp / 10000).toFixed(4)}×
              </span>
            </div>

            <input
              type="range"
              min={1}
              max={9999}
              step={1}
              value={target}
              onChange={(event) => setTarget(Number(event.target.value))}
            />
            <div className="target-track">
              <span
                className="target-marker"
                style={{ left: `${direction === 'under' ? target / 100 : 100 - target / 100}%` }}
              />
            </div>

            <div className="row gap" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div className="stack">
                <span className="muted small">Potential payout</span>
                <strong style={{ fontSize: 20 }}>{money(potential)}</strong>
              </div>
              <Button variant="primary" disabled={busy || !playerId || stakeMinor <= 0} onClick={() => void roll()}>
                {busy ? 'Rolling…' : 'Roll dice'}
              </Button>
            </div>

            {result ? (
              <div className="dice-stage">
                <span className={`dice-roll ${result.won ? 'win' : 'loss'}`}>
                  {(result.roll / 100).toFixed(2)}
                </span>
                <span className="dice-sub">
                  {result.direction} {result.target / 100} · {result.won ? 'won' : 'lost'} ·{' '}
                  {(result.multiplierBp / 10000).toFixed(4)}× · payout {money(result.payoutMinor)}
                </span>
                <span className="dice-sub">
                  balance after {money(result.balanceMinor)} · nonce {result.nonce} · hash{' '}
                  <span className="mono">{result.serverSeedHash.slice(0, 16)}…</span>
                </span>
              </div>
            ) : (
              <div className="dice-stage">
                <span className="dice-roll muted">—</span>
                <span className="dice-sub">Roll to see the outcome</span>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Fairness" subtitle="Rotate to reveal the previous server seed; new rounds use a fresh seed.">
          <div className="pad stack" style={{ gap: 12 }}>
            <div className="kv">
              <span>Current hash</span>
              <span className="mono small">{result?.serverSeedHash ?? fairness?.current?.serverSeedHash ?? '—'}</span>
            </div>
            <div className="kv">
              <span>Client seed</span>
              <span className="mono small">{result?.clientSeed ?? fairness?.current?.clientSeed ?? '—'}</span>
            </div>
            {fairness ? (
              <div className="stack" style={{ gap: 6 }}>
                <Badge tone="info">previous seed revealed</Badge>
                <div className="kv">
                  <span>Server seed</span>
                  <span className="mono small">{String(fairness.revealed.serverSeed)}</span>
                </div>
                <div className="kv">
                  <span>Hash</span>
                  <span className="mono small">{String(fairness.revealed.serverSeedHash)}</span>
                </div>
                <div className="kv">
                  <span>Final nonce</span>
                  <span className="mono small">{String(fairness.revealed.finalNonce)}</span>
                </div>
              </div>
            ) : null}
            <Button onClick={() => void rotate()} disabled={busy || !playerId}>
              Rotate & reveal seed
            </Button>
            <p className="muted small">
              Verify: roll = floor(uint32(HMAC-SHA256(serverSeed, "dice|clientSeed|nonce|0")) / 2³² × 10000).
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Your rounds" subtitle="Latest settled rounds for the selected player.">
        <Table
          columns={[
            { key: 'game_code', label: 'Game' },
            { key: 'stake_minor', label: 'Stake', align: 'right', render: (row) => money(row.stake_minor) },
            { key: 'payout_minor', label: 'Payout', align: 'right', render: (row) => money(row.payout_minor) },
            {
              key: 'status',
              label: 'Outcome',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'created_at', label: 'When', render: (row) => when(row.created_at as number) },
          ]}
          rows={history}
          empty="No rounds yet."
        />
      </Panel>
    </>
  );
}
