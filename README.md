# eaze Spin Wheel

Spin-the-wheel feature for [eaze](https://eazeapp.com) — one free spin per day, coin rewards credited directly to a user's eaze wallet.

Deployed at **https://spinwheel.eazeapp.com**

---

## What this is

| Part | Description |
|------|-------------|
| **Frontend** | Single-file HTML/CSS/Vanilla JS WebView (`public/index.html`). No framework, no build step. Max-width 430px, mobile-first. |
| **Backend** | Node.js + Express + PostgreSQL. Handles all API logic, Redash user lookup, and coin delivery via CSV upload to the Eaze Free Coins API. |
| **Admin** | Built-in dashboard at `/admin` — overview stats, player list, spin events, transfer requests. |

---

## Screens

- Login (mobile number entry)
- URL param auto-login — `?user_id=<base64 eaze_user_id>` skips the login screen entirely
- Spin wheel
- Win modal (coin reward + claim button)
- Better Luck modal
- Terms & Conditions overlay
- Logout sheet
- Admin dashboard

---

## Wheel segments

**Days 1–7 — deterministic (guaranteed, no Better Luck)**

| Day | Reward |
|-----|--------|
| 1–3 | 20 coins |
| 4 | 50 coins |
| 5–6 | 10 coins |
| 7 | 20 coins |

**Days 8–14 — probabilistic**

| Label | Probability | Coins |
|-------|-------------|-------|
| Better Luck | 60% | 0 |
| 10 Coins | 25% | 10 |
| 20 Coins | 9% | 20 |
| 50 Coins | 3% | 50 |
| 100 Coins | 2% | 100 |
| 200 Coins | 1% | 200 |

**Day 15+** — feature not active for these users.

---

## Repo structure

```
eaze-spin-wheel/
├── public/
│   ├── index.html              # Frontend WebView
│   └── admin.html              # Admin dashboard
├── src/
│   ├── server.js               # Express routes
│   ├── spin-wheel-service.js   # Business logic
│   └── db.js                   # PostgreSQL pool
├── scripts/
│   ├── create-tables.js        # One-time DB setup
│   └── test-connection.js      # DB connection test
├── sql/
│   └── create_spin_wheel_tables.sql
├── .env.example
├── Dockerfile
├── docker-compose.yml          # Local development
└── .github/workflows/
    └── docker-publish.yml      # CI/CD → GHCR
```

---

## API routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Health check |
| GET | `/api/config` | Public wheel config |
| POST | `/api/players/register` | Register / login |
| GET | `/api/players/:id/state` | Player state |
| POST | `/api/spin` | Perform a spin |
| POST | `/api/transfers` | Claim coins |
| POST | `/api/test/reset` | Reset tester data |

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

```env
# Database
DATABASE_URL=postgresql://app_user:app_password@localhost:5432/app_db
DB_SSL=false

# Server
PORT=3000

# Tester numbers (bypass spin limits for QA)
TESTER_MOBILE_NUMBERS=9999999999,9999999998

# Redash — mobile number → eaze_user_id lookup
REDASH_BASE_URL=https://redash.eazeapp.com
REDASH_API_KEY=
REDASH_QUERY_ID=

# Eaze Free Coins API
EAZE_FREE_COINS_AUTH_KEY=
EAZE_FREE_COINS_API_URL=https://api.eazeapp.com/payments/free-coins/upload/

# Admin dashboard
ADMIN_USERNAME=admin
ADMIN_PASSWORD=

# Slack alerts (optional)
SLACK_WEBHOOK_URL=
```

### Redash query

Create a query in Redash with this SQL, then set `REDASH_QUERY_ID` to its ID:

```sql
SELECT user_id, is_active
FROM users
WHERE mobile_number = '{{ mobile_number }}'
LIMIT 1
```

---

## Local development

```bash
cp .env.example .env
# fill in .env

npm install
docker compose up -d          # starts local PostgreSQL
npm run db:create-tables       # one-time setup
npm run db:test                # verify connection
npm run dev                    # http://localhost:3000
```

---

## Database schema

```sql
players (
  id, mobile_number UNIQUE nullable, display_name,
  total_coins DEFAULT 0, eaze_user_id, created_at, updated_at
)

spin_events (
  id, player_id → players, reward_key, reward_label,
  coin_value, spin_date DEFAULT CURRENT_DATE, created_at
)

transfer_requests (
  id, player_id → players, coins_requested, status,
  notes, error_message, provider_ref, created_at
)
```

Transfer `status` values: `submitted` | `success` | `mock_success` | `failed_provider` | `failed_not_registered`

---

## Deployment

Every push to `main` automatically builds and publishes a Docker image to GHCR:

```
ghcr.io/<org>/eaze-spin-wheel:latest
ghcr.io/<org>/eaze-spin-wheel:sha-<commit>
```

The Kubero deployment picks up `:latest` automatically — no manual steps needed after merge.

---

## URL auto-login

To deep-link a user directly to the wheel without asking them to enter their phone number:

```
https://spinwheel.eazeapp.com/?user_id=<base64(eaze_user_id)>
```

Example — for user ID `1476`:
```js
btoa('1476') // → "MTQ3Ng=="
// URL: https://spinwheel.eazeapp.com/?user_id=MTQ3Ng==
```

---

## Related

- Dostt Spin Wheel: [generic-db-client](https://github.com/marieswar-sketch/generic-db-client) — the reference implementation this was built from
