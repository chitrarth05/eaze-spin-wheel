import dotenv from 'dotenv';
import { runInTransaction, runQuery } from './db.js';

dotenv.config();

// ── Constants ─────────────────────────────────────────────────────────────────

const DAILY_SPIN_LIMIT = 1;
const DEFAULT_TESTER_NUMBERS = [];
const COUNTED_TRANSFER_STATUSES = ['submitted', 'success', 'mock_success'];

// Segment definitions — used for reward lookup and getPublicConfig().
// Actual reward probabilities are in COHORT_PROBABILITIES and DETERMINISTIC_SCHEDULE below.
// The order here must match CONFIG.wheelSegments in the frontend (index 0–5).
const WHEEL_SEGMENTS = [
  { id: '10_coins',    label: '10 Coins',              coin_value: 10  },
  { id: 'better_luck', label: 'Better Luck Next Time', coin_value: 0   },
  { id: '50_coins',    label: '50 Coins',              coin_value: 50  },
  { id: '200_coins',   label: '200 Coins',             coin_value: 200 },
  { id: '100_coins',   label: '100 Coins',             coin_value: 100 },
  { id: '20_coins',    label: '20 Coins',              coin_value: 20  },
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

// Days 8–14 — tier 1. Probabilities sum to 100.
const COHORT_PROBABILITIES_T1 = [
  { id: 'better_luck', probability: 60    },
  { id: '10_coins',    probability: 25    },
  { id: '20_coins',    probability:  9    },
  { id: '50_coins',    probability:  3    },
  { id: '100_coins',   probability:  2    },
  { id: '200_coins',   probability:  1    },
];

// Day 15+ — tier 2. Probabilities sum to 100.
const COHORT_PROBABILITIES_T2 = [
  { id: 'better_luck', probability: 65    },
  { id: '10_coins',    probability: 24.4  },
  { id: '20_coins',    probability:  9.5  },
  { id: '50_coins',    probability:  1    },
  { id: '100_coins',   probability:  0.09 },
  { id: '200_coins',   probability:  0.01 },
];

// ── Normalisation ─────────────────────────────────────────────────────────────

function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  return digits;
}

function isTester(eazeUserId) {
  const ids = process.env.TESTER_USER_IDS
    ? process.env.TESTER_USER_IDS.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  return eazeUserId ? ids.includes(String(eazeUserId)) : false;
}

function getCountedStatusesSql(startIndex = 2) {
  return COUNTED_TRANSFER_STATUSES.map((_, i) => `$${startIndex + i}`).join(', ');
}

// ── Reward determination ──────────────────────────────────────────────────────

function pickFromProbabilities(probs) {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const seg of probs) {
    cumulative += seg.probability;
    if (roll < cumulative) return WHEEL_SEGMENTS.find((s) => s.id === seg.id);
  }
  return WHEEL_SEGMENTS.find((s) => s.id === 'better_luck');
}

function determineReward(dayNumber, forcedRewardId = null) {
  // Tester forced reward — always takes precedence
  if (forcedRewardId) {
    const forced = WHEEL_SEGMENTS.find((s) => s.id === forcedRewardId);
    if (!forced) throw new Error(`Unknown reward id: ${forcedRewardId}`);
    return forced;
  }

  // Days 1–7 — deterministic guaranteed reward
  const deterministicId = DETERMINISTIC_SCHEDULE[dayNumber];
  if (deterministicId) {
    return WHEEL_SEGMENTS.find((s) => s.id === deterministicId);
  }

  // Days 8–14 — probabilistic tier 1
  if (dayNumber <= 14) return pickFromProbabilities(COHORT_PROBABILITIES_T1);

  // Day 15+ — probabilistic tier 2
  return pickFromProbabilities(COHORT_PROBABILITIES_T2);
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
      headers: { 'x-n8n-auth-key': authKey },
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
     FROM spin_events
     WHERE player_id = $1
       AND spin_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
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
       AND spin_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
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
  // No Redash lookup — take the number at face value and upsert the player.
  // Most users arrive via URL param (eazeUserId); mobile login is a fallback
  // and doesn't need validation.
  const normalized = normalizeMobile(mobileNumber);

  const { rows } = await runQuery(
    `INSERT INTO players (mobile_number)
     VALUES ($1)
     ON CONFLICT (mobile_number)
     DO UPDATE SET updated_at = NOW()
     RETURNING id, mobile_number, display_name, total_coins, eaze_user_id, created_at`,
    [normalized],
  );
  return { player: rows[0], is_active: true };
}

export async function getPlayerState(identifier) {
  return runInTransaction(async (client) => {
    let player;
    // Accept either a plain string (mobile or eaze_user_id) or a tagged object { eazeUserId }
    if (identifier && typeof identifier === 'object' && identifier.eazeUserId) {
      player = await getPlayerByEazeUserId(client, identifier.eazeUserId);
    } else {
      const normalized = normalizeMobile(identifier);
      if (/^\d{10}$/.test(normalized)) {
        player = await getPlayerByMobile(client, normalized);
      } else {
        player = await getPlayerByEazeUserId(client, identifier);
      }
    }
    if (!player) return null;

    const spinsToday = await getSpinsToday(client, player.id);

    return {
      id:              player.id,
      mobile_number:   player.mobile_number,
      eaze_user_id:    player.eaze_user_id,
      spins_used:      spinsToday,
      max_spins:       DAILY_SPIN_LIMIT,
      can_spin:        spinsToday < DAILY_SPIN_LIMIT,
      total_coins_won: Number(player.total_coins),
    };
  });
}

export async function spinForPlayer(mobileNumber, eazeUserId, forcedRewardId = null) {
  const tester = isTester(eazeUserId);

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
      `INSERT INTO spin_events (player_id, reward_key, reward_label, coin_value, spin_date)
       VALUES ($1, $2, $3, $4, (NOW() AT TIME ZONE 'Asia/Kolkata')::date) RETURNING id`,
      [player.id, reward.id, reward.label, reward.coin_value],
    );

    if (reward.coin_value > 0) {
      await client.query(
        `UPDATE players SET total_coins = total_coins + $2, updated_at = NOW() WHERE id = $1`,
        [player.id, reward.coin_value],
      );
      player.total_coins = Number(player.total_coins) + reward.coin_value;
      // Auto-fire coins API — result is logged but never blocks the spin
      const transferStatus = await autoTransferCoins(client, player, reward.coin_value);
      console.log(`Auto-transfer player ${player.eaze_user_id}: ${transferStatus}`);
    }

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
      },
    };
  });
}

async function autoTransferCoins(client, player, amount) {
  try {
    const providerResult = await uploadCoinsToEaze(player.eaze_user_id, amount);
    const status = providerResult.ok ? 'submitted' : 'failed_provider';
    await client.query(
      `INSERT INTO transfer_requests (player_id, coins_requested, status, notes, provider_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [player.id, amount, status, providerResult.message || null, providerResult.providerRef || null],
    );
    return status;
  } catch (err) {
    // Never throw — a transfer failure must not roll back the spin
    try {
      await client.query(
        `INSERT INTO transfer_requests (player_id, coins_requested, status, notes, error_message)
         VALUES ($1, $2, 'failed_provider', 'Auto-transfer exception', $3)`,
        [player.id, amount, err.message],
      );
    } catch (_) {}
    return 'failed_provider';
  }
}

export async function createTransferRequest(mobileNumber, eazeUserId, coinsRequested) {
  const normalized = mobileNumber ? normalizeMobile(mobileNumber) : null;
  const tester     = isTester(eazeUserId);

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

export async function resetTestData(eazeUserId) {
  const uid = String(eazeUserId);
  if (!isTester(uid)) throw new Error('Reset only allowed for tester user IDs');

  return runInTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM players WHERE eaze_user_id = $1', [uid]
    );
    const player = rows[0] || null;
    if (!player) return { status: 'ok', message: 'No data to reset' };
    await client.query('DELETE FROM transfer_requests WHERE player_id = $1', [player.id]);
    await client.query('DELETE FROM spin_events WHERE player_id = $1', [player.id]);
    await client.query(`UPDATE players SET total_coins = 0, updated_at = NOW() WHERE id = $1`, [player.id]);
    return { status: 'ok', message: 'Tester data reset' };
  });
}
