import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createTransferRequest,
  getPlayerState,
  getPublicConfig,
  registerPlayer,
  resetTestData,
  spinForPlayer,
} from './spin-wheel-service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const publicDir  = path.join(__dirname, '..', 'public');

const app  = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(publicDir));

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  return digits;
}


// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eaze-spin-wheel' });
});

app.get('/api/config', (_req, res) => {
  res.json(getPublicConfig());
});

/**
 * Register / login.
 *
 * Mobile login:         POST { mobileNumber: "9876543210" }
 *   → Redash lookup → validate active → upsert player → return player + state
 *
 * URL param auto-login: POST { eazeUserId: 1476 }
 *   → No Redash → upsert player (mobile_number = NULL) → return player + state
 */
app.post('/api/players/register', async (req, res) => {
  try {
    const { eazeUserId } = req.body;

    if (eazeUserId) {
      const uid = parseInt(String(eazeUserId), 10);
      if (isNaN(uid) || uid <= 0) {
        return res.status(400).json({ error: 'Invalid eazeUserId' });
      }
      const result = await registerPlayer({ eazeUserId: uid });
      const state  = await getPlayerState({ eazeUserId: uid });
      return res.status(201).json({ ...result, state });
    }

    const mobileNumber = cleanMobile(req.body.mobileNumber);
    if (mobileNumber.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required' });
    }

    const result = await registerPlayer({ mobileNumber });
    const state  = await getPlayerState(mobileNumber);
    return res.status(201).json({ ...result, state });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/players/:identifier/state', async (req, res) => {
  try {
    const state = await getPlayerState(req.params.identifier);
    if (!state) return res.status(404).json({ error: 'Player not found' });
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const mobileNumber   = req.body.mobileNumber ? cleanMobile(req.body.mobileNumber) : null;
    const eazeUserId     = req.body.eazeUserId   || null;
    const forcedRewardId = req.body.forcedReward  || null;

    if (!mobileNumber && !eazeUserId) {
      return res.status(400).json({ error: 'mobileNumber or eazeUserId is required' });
    }

    const result = await spinForPlayer(mobileNumber, eazeUserId, forcedRewardId);

    if (result.status === 'error' && result.reason === 'daily_limit_reached') {
      return res.status(429).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/transfers', async (req, res) => {
  try {
    const mobileNumber   = req.body.mobileNumber ? cleanMobile(req.body.mobileNumber) : null;
    const eazeUserId     = req.body.eazeUserId   || null;
    const coinsRequested = Number(req.body.coinsRequested);

    if (!mobileNumber && !eazeUserId) {
      return res.status(400).json({ error: 'mobileNumber or eazeUserId is required' });
    }
    if (!coinsRequested || coinsRequested <= 0) {
      return res.status(400).json({ error: 'coinsRequested must be a positive number' });
    }

    const transfer = await createTransferRequest(mobileNumber, eazeUserId, coinsRequested);

    if (transfer.status === 'failed_provider') {
      return res.status(502).json({ error: transfer.public_error || 'Transfer failed.', transfer });
    }

    res.status(201).json(transfer);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Tester reset ──────────────────────────────────────────────────────────────

app.post('/api/test/reset', async (req, res) => {
  try {
    const eazeUserId = req.body.eazeUserId;
    if (!eazeUserId) return res.status(400).json({ error: 'eazeUserId is required' });
    res.json(await resetTestData(eazeUserId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Fallback SPA ──────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  const msg = `🚨 *eaze spin wheel error*\n*Route:* ${req.method} ${req.path}\n*Error:* ${err.message}`;
  console.error(msg);
  res.status(500).json({ error: err.message });
});

app.listen(port, () => {
  console.log(`eaze spin wheel running on http://localhost:${port}`);
});
