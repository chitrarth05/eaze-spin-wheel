import dotenv from 'dotenv';
import { runInTransaction, runQuery } from './db.js';

dotenv.config();

// ── Constants ─────────────────────────────────────────────────────────────────

const DAILY_SPIN_LIMIT = 1;
const DEFAULT_TESTER_NUMBERS = [];
const COUNTED_TRANSFER_STATUSES = ['submitted', 'success', 'mock_success'];

const WHEEL_SEGMENTS = [
  { id: '10_coins',    label: '10 Coins',              coin_value: 10,  probability: 30 },
  { id: 'better_luck', label: 'Better Luck Next Time', coin_value: 0,   probability: 12 },
  { id: '50_coins',    label: '50 Coins',              coin_value: 50,  probability: 20 },
  { id: '200_coins',   label: '200 Coins',             coin_value: 200, probability: 5  },
  { id: '100_coins',   label: '100 Coins',             coin_value: 100, probability: 10 },
  { id: '20_coins',    label: '20 Coins',              coin_value: 20,  probability: 23 },
];

// ── Cohort reward config ──────────────────────────────────────────────────────
//
// Day number = number of distinct calendar days a player has spun (including today).
// Computed purely from spin_events — no external calls needed.
//
// Days 1–7:  deterministic (guaranteed coin amount, no Better Luck)
// Days 8–14: probabilistic tier 1
// Day 15+:   feature not active for these users (returns Better Luck gracefully)

const DETERMINISTIC_SCHEDULE = {
  1: '20_coins',
  2: '20_coins',
  3: '20_coins',
  4: '50_coins',
  5: '10_coins',
  6: '10_coins',
  7: '20_coins',
};

// Probabilities must sum to 100
const COHORT_PROBABILITIES = [
  { id: 'better_luck', probability: 60 },
  { id: '10_coins',    probability: 25 },
  { id: '20_coins',    probability:  9 },
  { id: '50_coins',    probability:  3 },
  { id: '100_coins',   probability:  2 },
  { id: '200_coins',   probability:  1 },
];

// ── Normalisation ─────────────────────────────────────────────────────────────

function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  return digits;
}

function getTesterNumbers() {
  const configured = process.env.TESTER_MOBILE_NUMBERS
    ? process.env.TESTER_MOBILE_NUMBERS.split(',').map((v) => normalizeMobile(v.trim())).filter(Boolean)
    : [];
  return configured.length > 0 ? configured : DEFAULT_TESTER_NUMBERS;
}

function isTester(mobileNumber) {
  return mobileNumber ? getTesterNumbers().includes(normalizeMobile(mobileNumber)) : false;
}

function getCountedStatusesSql(startIndex = 2) {
  return COUNTED_TRANSFER_STATUSES.map((_, i) => `$${startIndex + i}`).join(', ');
}

// ── Reward determination ──────────────────────────────────────────────────────

function determineReward(dayNumber, forcedRewardId = null) {
  // Tester forced reward — always takes precedence
  if (forcedRewardId) {
    const forced = WHEEL_SEGMENTS.find((s) => s.id === forcedRewardId);
    if (!forced) throw new Error(`Unknown reward id: ${forcedRewardId}`);
    return forced;
  }

  // Day 15+ — feature not active for this user, return Better Luck gracefully
  if (dayNumber > 14) {
    return WHEEL_SEGMENTS.find((s) => s.id === 'better_luck');
  }

  // Days 1–7 — deterministic guaranteed reward
  const deterministicId = DETERMINISTIC_SCHEDULE[dayNumber];
  if (deterministicId) {
    return WHEEL_SEGMENTS.find((s) => s.id === deterministicId);
  }

  // Days 8–14 — probabilistic tier 1
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const seg of COHORT_PROBABILITIES) {
    cumulative += seg.probability;
    if (roll < cumulative) return WHEEL_SEGMENTS.find((s) => s.id === seg.id);
  }
  return WHEEL_SEGMENTS.find((s) => s.id === 'better_luck');
}

// ── Redash user lookup ────────────────────────────────────────────────────────

export async function lookupEazeUserId(mobileNumber) {
  const baseUrl = process.env.REDASH_BASE_URL;
  const apiKey  = process.env.REDASH_API_KEY;
  const queryId = process.env.REDASH_QUERY_ID;

  if (!baseUrl || !apiKey || !queryId) {
    return { userId: null, isActive: false, reason: 'lookup_not_configured' };
  }

  const normalized = normalizeMobile(mobileNumber);
  const response   = await fetch(`${baseUrl}/api/queries/${queryId}/results`, {
    method:  'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ parameters: { mobile_number: normalized } }),
  });
  const data = await response.json();

  const extractUser = (rows = []) =>
    rows.find((r) => normalizeMobile(r.mobile_number) === normalized);

  if (data.query_result) {
    const match = extractUser(data.query_result.data.rows);
    return {
      userId:   match?.user_id ? String(match.user_id) : null,
      isActive: match?.is_active === 1 || match?.is_active === true,
      reason:   match ? null : 'not_registered',
    };
  }

  if (data.job?.id) {
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const jobRes  = await fetch(`${baseUrl}/api/jobs/${data.job.id}`, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const jobData = await jobRes.json();

      if (jobData.job.status === 3) {
        const finalRes  = await fetch(
          `${baseUrl}/api/query_results/${jobData.job.query_result_id}`,
          { headers: { Authorization: `Key ${apiKey}` } },
        );
        const finalData = await finalRes.json();
        const match     = extractUser(finalData.query_result.data.rows);
        return {
          userId:   match?.user_id ? String(match.user_id) : null,
          isActive: match?.is_active === 1 || match?.is_active === true,
          reason:   match ? null : 'not_registered',
        };
      }
      if (jobData.job.status === 4) throw new Error(jobData.job.error || 'Redash job failed');
    }
    throw new Error('Redash lookup timed out');
  }

  return { userId: null, isActive: false, reason: 'not_registered' };
}

// ── CSV upload to Eaze Free Coins API ─────────────────────────────────────────
// Same pattern as the Dostt implementation.

async function uploadCoinsToEaze(eazeUserId, amount) {
  const authKey = process.env.EAZE_FREE_COINS_AUTH_KEY;
  const apiUrl  = process.env.EAZE_FREE_COINS_API_URL || 'https://api.eazeapp.com/payments/free-coins/upload/';

  if (!authKey) {
    return { ok: true, providerRef: 'mock-transfer', message: 'Mock transfer — EAZE_FREE_COINS_AUTH_KEY not configured.' };
  }

  const csvContent = `user_id,coins\n${eazeUserId},${amount}`;
  const formData   = new FormData();
  formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'transfer.csv');
  formData.append('name', 'Spin the Wheel');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  let response, text;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'x-eaze-auth-key': authKey },
      body:    formData,
      signal:  controller.signal,
    });
    text = await response.text();
  } catch (err) {
    throw new Error(`Eaze Free Coins API timed out or failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok:          response.ok || text.includes('Bulk upload started'),
    providerRef: String(eazeUserId),
    message:     text,
  };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch (_) {}
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getPlayerByMobile(client, mobileNumber) {
  const { rows } = await client.query(
    `SELECT id, mobile_number, display_name, total_coins, eaze_user_id, created_at, updated_at
     FROM players WHERE mobile_number = $1`,
    [normalizeMobile(mobileNumber)],
  );
  return rows[0] || null;
}

async function getPlayerByEazeUserId(client, eazeUserId) {
  const { rows } = await client.query(
    `SELECT id, mobile_number, display_name, total_coins, eaze_user_id, created_at, updated_at
     FROM players WHERE eaze_user_id = $1`,
    [String(eazeUserId)],
  );
  return rows[0] || null;
}

async function getSpinsToday(client, playerId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS spins_today
     FROM spin_events WHERE player_id = $1 AND spin_date = CURRENT_DATE`,
    [playerId],
  );
  return rows[0].spins_today;
}

// Returns 1 on the player's first ever spin day, 2 on the second, etc.
// Counts distinct calendar dates the player has spun, including today.
async function getDayNumber(client, playerId) {
  const { rows } = await client.query(
    `SELECT COUNT(DISTINCT spin_date)::int AS completed_days
     FROM spin_events
     WHERE player_id = $1
       AND spin_date < CURRENT_DATE`,
    [playerId],
  );
  return rows[0].completed_days + 1;
}

async function getTransferredToday(client, playerId) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM transfer_requests
       WHERE player_id = $1
         AND status IN (${getCountedStatusesSql()})
         AND created_at >= date_trunc('day', NOW())
         AND created_at <  date_trunc('day', NOW()) + interval '1 day'
     ) AS transferred_today`,
    [playerId, ...COUNTED_TRANSFER_STATUSES],
  );
  return rows[0].transferred_today;
}

async function getTransferredCoins(client, playerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(coins_requested), 0)::int AS transferred_coins
     FROM transfer_requests
     WHERE player_id = $1 AND status IN (${getCountedStatusesSql()})`,
    [playerId, ...COUNTED_TRANSFER_STATUSES],
  );
  return rows[0].transferred_coins;
}

// ── Public service functions ──────────────────────────────────────────────────

export function getPublicConfig() {
  return {
    wheelSegments:       WHEEL_SEGMENTS,
    testerMobileNumbers: getTesterNumbers(),
    dailySpinLimit:      DAILY_SPIN_LIMIT,
    terms: [
      'You are entitled to 1 free spin per day.',
      'Coins are credited to your eaze wallet automatically after claiming.',
      'Tester mobile numbers can bypass the daily spin limit and force specific rewards.',
    ],
  };
}

/**
 * Register or fetch a player.
 * Accepts EITHER mobileNumber (normal login) OR eazeUserId (URL param auto-login).
 * When eazeUserId is provided, mobile_number is stored as NULL.
 */
export async function registerPlayer({ mobileNumber, eazeUserId }) {
  // ── URL param auto-login path ──────────────────────────────────────────────
  if (eazeUserId) {
    const uid = String(eazeUserId);

    // Upsert by eaze_user_id — no Redash lookup needed, id already known
    const { rows } = await runQuery(
      `INSERT INTO players (eaze_user_id)
       VALUES ($1)
       ON CONFLICT (eaze_user_id)
       DO UPDATE SET updated_at = NOW()
       RETURNING id, mobile_number, display_name, total_coins, eaze_user_id, created_at`,
      [uid],
    );
    return { player: rows[0], is_active: true };
  }

  // ── Mobile login path ──────────────────────────────────────────────────────
  const normalized = normalizeMobile(mobileNumber);

  // Resolve eaze_user_id from Redash
  let resolvedUserId = null;
  let isActive       = false;
  try {
    const lookup  = await lookupEazeUserId(normalized);
    resolvedUserId = lookup.userId;
    isActive       = lookup.isActive;
    if (!resolvedUserId) {
      return { player: null, is_active: false, reason: lookup.reason || 'not_registered' };
    }
  } catch (err) {
    return { player: null, is_active: false, reason: 'lookup_failed', detail: err.message };
  }

  const { rows } = await runQuery(
    `INSERT INTO players (mobile_number, eaze_user_id)
     VALUES ($1, $2)
     ON CONFLICT (mobile_number)
     DO UPDATE SET
       eaze_user_id = COALESCE(EXCLUDED.eaze_user_id, players.eaze_user_id),
       updated_at   = NOW()
     RETURNING id, mobile_number, display_name, total_coins, eaze_user_id, created_at`,
    [normalized, resolvedUserId],
  );
  return { player: rows[0], is_active: isActive };
}

export async function getPlayerState(identifier) {
  return runInTransaction(async (client) => {
    // identifier can be mobile number or eaze_user_id
    let player;
    const normalized = normalizeMobile(identifier);
    if (/^\d{10}$/.test(normalized)) {
      player = await getPlayerByMobile(client, normalized);
    } else {
      player = await getPlayerByEazeUserId(client, identifier);
    }
    if (!player) return null;

    const spinsToday      = await getSpinsToday(client, player.id);
    const transferredToday = await getTransferredToday(client, player.id);
    const transferredCoins = await getTransferredCoins(client, player.id);

    return {
      id:               player.id,
      mobile_number:    player.mobile_number,
      eaze_user_id:     player.eaze_user_id,
      spins_used:       spinsToday,
      max_spins:        DAILY_SPIN_LIMIT,
      can_spin:         spinsToday < DAILY_SPIN_LIMIT,
      total_coins_won:  Number(player.total_coins),
      unclaimed_coins:  Math.max(0, Number(player.total_coins) - transferredCoins),
      transferred_today: transferredToday,
    };
  });
}

export async function spinForPlayer(mobileNumber, eazeUserId, forcedRewardId = null) {
  const tester = isTester(mobileNumber);

  return runInTransaction(async (client) => {
    // Find or auto-create the player
    let player = mobileNumber
      ? await getPlayerByMobile(client, mobileNumber)
      : await getPlayerByEazeUserId(client, eazeUserId);

    if (!player) {
      const insertVals = mobileNumber
        ? [normalizeMobile(mobileNumber), null]
        : [null, String(eazeUserId)];
      const { rows } = await client.query(
        `INSERT INTO players (mobile_number, eaze_user_id) VALUES ($1, $2)
         RETURNING id, mobile_number, display_name, total_coins, eaze_user_id, created_at`,
        insertVals,
      );
      player = rows[0];
    }

    const spinsToday = await getSpinsToday(client, player.id);
    if (!tester && spinsToday >= DAILY_SPIN_LIMIT) {
      return { status: 'error', reason: 'daily_limit_reached' };
    }

    const dayNumber = await getDayNumber(client, player.id);
    const reward    = determineReward(dayNumber, tester ? forcedRewardId : null);

    const { rows: spinRows } = await client.query(
      `INSERT INTO spin_events (player_id, reward_key, reward_label, coin_value)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [player.id, reward.id, reward.label, reward.coin_value],
    );

    if (reward.coin_value > 0) {
      await client.query(
        `UPDATE players SET total_coins = total_coins + $2, updated_at = NOW() WHERE id = $1`,
        [player.id, reward.coin_value],
      );
      player.total_coins = Number(player.total_coins) + reward.coin_value;
    }

    const transferredCoins = await getTransferredCoins(client, player.id);

    return {
      status:        'ok',
      reward:        { id: reward.id, label: reward.label, coin_value: reward.coin_value, is_win: reward.coin_value > 0 },
      spin_event_id: spinRows[0].id,
      day_number:    dayNumber,
      player: {
        id:              player.id,
        spins_used:      spinsToday + 1,
        max_spins:       DAILY_SPIN_LIMIT,
        can_spin:        false,
        total_coins_won: Number(player.total_coins),
        unclaimed_coins: Math.max(0, Number(player.total_coins) - transferredCoins),
      },
    };
  });
}

export async function createTransferRequest(mobileNumber, eazeUserId, coinsRequested) {
  const normalized = mobileNumber ? normalizeMobile(mobileNumber) : null;
  const tester     = isTester(normalized);

  return runInTransaction(async (client) => {
    const player = normalized
      ? await getPlayerByMobile(client, normalized)
      : await getPlayerByEazeUserId(client, eazeUserId);

    if (!player) throw new Error('Player not found');

    const transferredToday = await getTransferredToday(client, player.id);
    const transferredCoins = await getTransferredCoins(client, player.id);
    const totalWinnings    = Math.max(0, Number(player.total_coins) - transferredCoins);

    if (coinsRequested <= 0) throw new Error('Coins requested must be greater than zero');
    if (!tester && transferredToday) throw new Error('Transfer already completed for today');
    if (coinsRequested > totalWinnings) throw new Error('Requested coins exceed available balance');

    // Mock mode (no auth key configured)
    if (!process.env.EAZE_FREE_COINS_AUTH_KEY) {
      const { rows } = await client.query(
        `INSERT INTO transfer_requests (player_id, coins_requested, status, notes, provider_ref)
         VALUES ($1, $2, 'mock_success', 'Mock transfer — auth key not configured', 'mock')
         RETURNING *`,
        [player.id, coinsRequested],
      );
      return rows[0];
    }

    // CSV upload to Eaze
    const providerResult = await uploadCoinsToEaze(player.eaze_user_id, coinsRequested);

    if (!providerResult.ok) {
      const { rows } = await client.query(
        `INSERT INTO transfer_requests (player_id, coins_requested, status, notes, error_message, provider_ref)
         VALUES ($1, $2, 'failed_provider', 'CSV upload to Eaze failed', $3, $4) RETURNING *`,
        [player.id, coinsRequested, providerResult.message, providerResult.providerRef],
      );
      await notifySlack(
        `❌ Spin Wheel Transfer Failed\nUser ID: ${player.eaze_user_id}\nCoins: ${coinsRequested}\nError: ${providerResult.message}`,
      );
      return { ...rows[0], public_error: 'Could not complete the transfer right now. Please try again shortly.' };
    }

    const { rows } = await client.query(
      `INSERT INTO transfer_requests (player_id, coins_requested, status, notes, provider_ref)
       VALUES ($1, $2, 'submitted', $3, $4) RETURNING *`,
      [player.id, coinsRequested, providerResult.message || 'CSV upload submitted', providerResult.providerRef],
    );

    await notifySlack(
      `✅ Spin Wheel Transfer\nUser ID: ${player.eaze_user_id}\nMobile: ${player.mobile_number || 'n/a'}\nCoins: ${coinsRequested}`,
    );

    return rows[0];
  });
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function getAdminStats() {
  const { rows: overview } = await runQuery(`
    SELECT
      (SELECT COUNT(*)::int FROM players) AS total_players,
      (SELECT COUNT(*)::int FROM players
       WHERE DATE(created_at AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE AT TIME ZONE 'Asia/Kolkata') AS today_new_players,
      (SELECT COUNT(*)::int FROM spin_events) AS total_spins,
      (SELECT COUNT(*)::int FROM spin_events
       WHERE spin_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS today_spins,
      (SELECT COUNT(DISTINCT player_id)::int FROM spin_events
       WHERE spin_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS today_active_players,
      (SELECT COALESCE(SUM(total_coins),0)::int FROM players) AS total_coins_won,
      (SELECT COALESCE(SUM(coins_requested),0)::int FROM transfer_requests
       WHERE status IN ('submitted','success','mock_success')) AS total_coins_transferred,
      (SELECT COUNT(*)::int FROM transfer_requests
       WHERE status IN ('failed_provider','failed_not_registered')) AS total_failed_transfers,
      (SELECT COUNT(*)::int FROM transfer_requests
       WHERE status IN ('submitted','success','mock_success')) AS total_successful_transfers
  `);

  const { rows: dailySpins }   = await runQuery(`
    SELECT spin_date::text AS date, COUNT(*)::int AS count
    FROM spin_events WHERE spin_date >= CURRENT_DATE - INTERVAL '29 days'
    GROUP BY spin_date ORDER BY spin_date
  `);
  const { rows: rewardsBreakdown } = await runQuery(`
    SELECT reward_key, COUNT(*)::int AS count FROM spin_events GROUP BY reward_key
  `);
  const { rows: topPlayers }   = await runQuery(`
    SELECT p.mobile_number, p.eaze_user_id, p.total_coins,
           COALESCE((SELECT SUM(tr.coins_requested) FROM transfer_requests tr
             WHERE tr.player_id=p.id AND tr.status IN ('submitted','success','mock_success')),0)::int AS transferred,
           (SELECT COUNT(*)::int FROM spin_events se WHERE se.player_id=p.id) AS total_spins,
           (SELECT MAX(spin_date)::text FROM spin_events se WHERE se.player_id=p.id) AS last_spin
    FROM players p ORDER BY p.total_coins DESC LIMIT 20
  `);

  return { overview: overview[0], charts: { dailySpins, rewardsBreakdown }, topPlayers };
}

export async function getAdminTableData(type, filters = {}) {
  if (type === 'players') {
    const { rows } = await runQuery(`
      SELECT p.id, p.mobile_number, p.eaze_user_id, p.display_name, p.total_coins,
             COALESCE((SELECT SUM(tr.coins_requested) FROM transfer_requests tr
               WHERE tr.player_id=p.id AND tr.status IN ('submitted','success','mock_success')),0)::int AS transferred_coins,
             (SELECT COUNT(*)::int FROM spin_events se WHERE se.player_id=p.id) AS total_spins,
             p.created_at AT TIME ZONE 'Asia/Kolkata' AS created_at
      FROM players p ORDER BY p.created_at DESC LIMIT 5000
    `);
    return rows;
  }
  if (type === 'spins') {
    const dateFilter = filters.date ? 'AND se.spin_date = $1::date' : '';
    const params = filters.date ? [filters.date] : [];
    const { rows } = await runQuery(`
      SELECT se.id, p.mobile_number, p.eaze_user_id, se.reward_key, se.reward_label,
             se.coin_value, se.spin_date, se.created_at AT TIME ZONE 'Asia/Kolkata' AS created_at
      FROM spin_events se JOIN players p ON p.id=se.player_id
      WHERE 1=1 ${dateFilter} ORDER BY se.created_at DESC LIMIT 10000
    `, params);
    return rows;
  }
  if (type === 'transfers') {
    const conditions = ['1=1'], params = [];
    if (filters.status) { params.push(filters.status); conditions.push(`tr.status = $${params.length}`); }
    if (filters.date)   { params.push(filters.date);   conditions.push(`DATE(tr.created_at AT TIME ZONE 'Asia/Kolkata') = $${params.length}::date`); }
    if (filters.mobile) { params.push(`%${filters.mobile}%`); conditions.push(`p.mobile_number LIKE $${params.length}`); }
    const { rows } = await runQuery(`
      SELECT tr.id, p.mobile_number, p.eaze_user_id, tr.coins_requested, tr.status,
             tr.error_message, tr.notes, tr.provider_ref,
             tr.created_at AT TIME ZONE 'Asia/Kolkata' AS created_at
      FROM transfer_requests tr JOIN players p ON p.id=tr.player_id
      WHERE ${conditions.join(' AND ')} ORDER BY tr.created_at DESC LIMIT 5000
    `, params);
    return rows;
  }
  return [];
}

export async function resetTestData(mobileNumber) {
  const normalized = normalizeMobile(mobileNumber);
  if (!isTester(normalized)) throw new Error('Reset only allowed for tester numbers');

  return runInTransaction(async (client) => {
    const player = await getPlayerByMobile(client, normalized);
    if (!player) return { status: 'ok', message: 'No data to reset' };
    await client.query('DELETE FROM transfer_requests WHERE player_id = $1', [player.id]);
    await client.query('DELETE FROM spin_events WHERE player_id = $1', [player.id]);
    await client.query(`UPDATE players SET total_coins = 0, updated_at = NOW() WHERE id = $1`, [player.id]);
    return { status: 'ok', message: 'Tester data reset' };
  });
}
