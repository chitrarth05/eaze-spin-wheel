import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createTransferRequest,
  getAdminStats,
  getAdminTableData,
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

async function sendSlackAlert(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (_) {}
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eaze-spin-wheel' });
});

app.get('/api/config', (_req, res) => {
  res.json(getPublicConfig());
});

/**
 * Register / login.
 *
 * Normal login:       { mobileNumber: "9876543210" }
 *   → Redash lookup, validate user is active, create/update player row
 *
 * URL param auto-login: { eazeUserId: 1476 }
 *   → Skip Redash, create player with mobile_number = NULL, eaze_user_id = 1476
 */
app.post('/api/players/register', async (req, res) => {
  try {
    const { eazeUserId } = req.body;

    // ── URL param path ──────────────────────────────────────────────────────
    if (eazeUserId) {
      const uid = parseInt(String(eazeUserId), 10);
      if (isNaN(uid) || uid <= 0) {
        return res.status(400).json({ error: 'Invalid eazeUserId' });
      }
      const result = await registerPlayer({ eazeUserId: uid });
      const state  = await getPlayerState(String(uid));
      return res.status(201).json({ ...result, state });
    }

    // ── Mobile number path ──────────────────────────────────────────────────
    const mobileNumber = cleanMobile(req.body.mobileNumber);
    if (mobileNumber.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required' });
    }

    const result = await registerPlayer({ mobileNumber });

    if (!result.player) {
      return res.status(404).json({ error: 'Mobile number not found in eaze. Please use your registered number.', reason: result.reason });
    }
    if (!result.is_active) {
      return res.status(403).json({ error: 'Your eaze account is not active.' });
    }

    const state = await getPlayerState(mobileNumber);
    res.status(201).json({ ...result, state });
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
    const mobileNumber  = req.body.mobileNumber ? cleanMobile(req.body.mobileNumber) : null;
    const eazeUserId    = req.body.eazeUserId   || null;
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

// ── Admin ─────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const user = req.headers['x-admin-user'];
  const pass = req.headers['x-admin-pass'];
  if (user === process.env.ADMIN_USERNAME && pass === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try { res.json(await getAdminStats()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/data/:type', requireAdmin, async (req, res) => {
  try {
    const filters = { status: req.query.status, date: req.query.date, mobile: req.query.mobile };
    res.json(await getAdminTableData(req.params.type, filters));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// ── Tester reset ──────────────────────────────────────────────────────────────

app.post('/api/test/reset', async (req, res) => {
  try {
    res.json(await resetTestData(cleanMobile(req.body.mobileNumber)));
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
  sendSlackAlert(msg);
  res.status(500).json({ error: err.message });
});

app.listen(port, () => {
  console.log(`eaze spin wheel running on http://localhost:${port}`);
});
