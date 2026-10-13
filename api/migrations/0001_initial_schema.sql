-- Initial schema for the standalone Monad project. Apply only to an empty database.
PRAGMA foreign_keys = ON;

CREATE TABLE "approval_intents" (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  token_symbol TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_decimals INTEGER,
  pool_address TEXT,
  spender TEXT NOT NULL,
  amount TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  created_at INTEGER NOT NULL,
  pool_token_address TEXT);

CREATE TABLE "auth_challenges" (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  owner_address TEXT NOT NULL COLLATE NOCASE,
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge_id TEXT NOT NULL UNIQUE REFERENCES auth_challenges(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE automation_mandates (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  pool_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'autopilot')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  band TEXT NOT NULL CHECK (band IN ('wide', 'balanced', 'narrow', 'agent')),
  max_position_usd INTEGER NOT NULL CHECK (max_position_usd > 0),
  max_runs_per_day INTEGER NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 24),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  venue TEXT CHECK (venue IN ('uniswap-v3', 'uniswap-v4')), token_id TEXT);

CREATE TABLE automation_model_calls (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES automation_mandates(id),
  kind TEXT NOT NULL CHECK (kind IN ('rebalance', 'close')),
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'running', 'done', 'failed', 'declined', 'expired')
  ),
  band TEXT CHECK (band IN ('wide', 'balanced', 'narrow')),
  -- Why: the user started it, or what the agent saw and decided, in plain words.
  trigger TEXT NOT NULL,
  reason TEXT,
  provider TEXT,
  model TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  token_id TEXT, wallet_id TEXT REFERENCES managed_wallets(id), state_json TEXT);

CREATE TABLE chain_indexer_checkpoints (
  name TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mainnet_execution_rehearsals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  decision TEXT NOT NULL CHECK (decision IN ('ready', 'rejected')),
  reason_code TEXT NOT NULL,
  observed_pending_nonce INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE mainnet_policy_evaluations (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'rejected')),
  reason_code TEXT NOT NULL,
  block_number INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE mainnet_transaction_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  transaction_hash TEXT NOT NULL UNIQUE COLLATE NOCASE,
  replaces_attempt_id TEXT REFERENCES mainnet_transaction_attempts(id),
  status TEXT NOT NULL CHECK (
    status IN ('submitted', 'confirmed', 'reverted', 'replaced', 'dropped', 'nonce_conflict')
  ),
  submitted_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  missing_observations INTEGER NOT NULL DEFAULT 0 CHECK (missing_observations >= 0),
  block_number INTEGER,
  final_reason TEXT, chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  CHECK (
    (status = 'submitted' AND block_number IS NULL AND final_reason IS NULL)
    OR (status <> 'submitted' AND final_reason IS NOT NULL)
  )
);

CREATE TABLE mainnet_transaction_reconciliations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES mainnet_transaction_attempts(id),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'confirmed', 'reverted', 'dropped', 'nonce_conflict')
  ),
  reason_code TEXT NOT NULL,
  latest_nonce INTEGER,
  pending_nonce INTEGER,
  block_number INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE managed_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  owner_address_at_creation TEXT NOT NULL COLLATE NOCASE,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT NOT NULL CHECK (
    state IN ('provisioning', 'active', 'paused', 'withdrawing', 'closed', 'quarantined')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dynamic_wallet_id TEXT);

CREATE TABLE mint_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  position_manager TEXT NOT NULL,
  recipient TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  amount0_desired TEXT NOT NULL,
  amount1_desired TEXT NOT NULL,
  amount0_min TEXT NOT NULL,
  amount1_min TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  simulated_token_id TEXT,
  simulated_liquidity TEXT,
  simulated_amount0 TEXT,
  simulated_amount1 TEXT,
  created_at INTEGER NOT NULL,
  token_address TEXT, token_symbol TEXT, token_decimals INTEGER, pool_address TEXT, token0_address TEXT, token1_address TEXT, fee INTEGER, tick_spacing INTEGER, token_id TEXT);

CREATE TABLE monad_nadfun_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('add', 'remove', 'clear')),
  -- The pair and its state at preview; NULL for a delegation clear.
  pair_address TEXT COLLATE NOCASE,
  token0_address TEXT COLLATE NOCASE,
  token1_address TEXT COLLATE NOCASE,
  token0_decimals INTEGER,
  token1_decimals INTEGER,
  meme_token TEXT COLLATE NOCASE,
  reserve0 TEXT,
  reserve1 TEXT,
  total_supply TEXT,
  -- add
  amount0_desired TEXT,
  amount1_desired TEXT,
  wrap_amount TEXT,
  lp_before TEXT,
  -- remove
  liquidity TEXT,
  balance0_before TEXT,
  balance1_before TEXT,
  slippage_bps INTEGER,
  calldata TEXT NOT NULL,
  -- The wallet's EIP-7702 delegate at preview, or NULL for a plain account.
  delegate_before TEXT,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE monad_nadfun_pair_directory (
  pair_address TEXT PRIMARY KEY COLLATE NOCASE,
  token0_address TEXT NOT NULL COLLATE NOCASE,
  token0_symbol TEXT NOT NULL,
  token0_decimals INTEGER NOT NULL,
  token1_address TEXT NOT NULL COLLATE NOCASE,
  token1_symbol TEXT NOT NULL,
  token1_decimals INTEGER NOT NULL,
  meme_token TEXT NOT NULL COLLATE NOCASE,
  reserve0 TEXT NOT NULL,
  reserve1 TEXT NOT NULL,
  liquidity TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_block INTEGER
);

CREATE TABLE monad_swap_approval_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  venue TEXT NOT NULL CHECK (venue IN ('uniswap-v3', 'uniswap-v4', 'nadfun-v2')),
  pair_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT,
  currency1 TEXT,
  fee INTEGER,
  tick_spacing INTEGER,
  hooks TEXT,
  token TEXT NOT NULL COLLATE NOCASE,
  stage TEXT NOT NULL CHECK (stage IN ('erc20', 'permit2')),
  spender TEXT NOT NULL COLLATE NOCASE,
  amount TEXT NOT NULL,
  expiration TEXT NOT NULL,
  target TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE monad_swap_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  venue TEXT NOT NULL CHECK (venue IN ('uniswap-v3', 'uniswap-v4', 'nadfun-v2')),
  pair_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT,
  currency1 TEXT,
  fee INTEGER,
  tick_spacing INTEGER,
  hooks TEXT,
  token_in TEXT NOT NULL COLLATE NOCASE,
  token_out TEXT NOT NULL COLLATE NOCASE,
  amount_in TEXT NOT NULL,
  amount_out_quoted TEXT NOT NULL,
  amount_out_minimum TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  price_impact_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  target TEXT NOT NULL,
  calldata TEXT NOT NULL,
  native_value TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE monad_v3_pool_directory (
  pool_address TEXT PRIMARY KEY COLLATE NOCASE,
  token0_address TEXT NOT NULL COLLATE NOCASE,
  token0_symbol TEXT NOT NULL,
  token0_decimals INTEGER NOT NULL,
  token1_address TEXT NOT NULL COLLATE NOCASE,
  token1_symbol TEXT NOT NULL,
  token1_decimals INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_block INTEGER
);

CREATE TABLE monad_v4_approval_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token TEXT NOT NULL COLLATE NOCASE,
  token_decimals INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('erc20', 'permit2')),
  amount TEXT NOT NULL,
  expiration TEXT NOT NULL,
  target TEXT NOT NULL COLLATE NOCASE,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE monad_v4_mint_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token0_decimals INTEGER NOT NULL,
  token1_decimals INTEGER NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  amount0_desired TEXT NOT NULL,
  amount1_desired TEXT NOT NULL,
  amount0_max TEXT NOT NULL,
  amount1_max TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  token_id TEXT,
  created_at INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL DEFAULT '0', tick INTEGER NOT NULL DEFAULT 0, liquidity TEXT NOT NULL DEFAULT '0', lp_fee INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL DEFAULT '0');

CREATE TABLE monad_v4_pool_directory (
  pool_id TEXT PRIMARY KEY COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  token0_symbol TEXT NOT NULL,
  token0_decimals INTEGER NOT NULL,
  token1_symbol TEXT NOT NULL,
  token1_decimals INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  lp_fee INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_block INTEGER
);

CREATE TABLE "monad_v4_position_action_intents" (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('collect', 'decrease', 'withdraw')),
  remove_bps INTEGER NOT NULL CHECK (remove_bps BETWEEN 0 AND 10000),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  token_id TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL DEFAULT '0',
  tick INTEGER NOT NULL DEFAULT 0,
  pool_liquidity TEXT NOT NULL DEFAULT '0',
  lp_fee INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE monad_withdrawal_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  asset_address TEXT NOT NULL COLLATE NOCASE,
  recipient TEXT NOT NULL COLLATE NOCASE,
  amount TEXT NOT NULL,
  owner_address TEXT NOT NULL COLLATE NOCASE,
  owner_signature TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  signature_expires_at INTEGER NOT NULL,
  target_address TEXT NOT NULL COLLATE NOCASE,
  calldata TEXT NOT NULL,
  native_value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE "pool_directory_skips" (
  pool_key TEXT PRIMARY KEY COLLATE NOCASE,
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap-v3', 'uniswap-v4', 'nadfun-v2')),
  created_at INTEGER NOT NULL
);

CREATE TABLE position_action_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('increase', 'decrease', 'collect', 'withdraw')),
  chain_id INTEGER NOT NULL CHECK (chain_id = 143),
  position_manager TEXT NOT NULL,
  token_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  calldata TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  simulation_output_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE signing_audit_log (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason_code TEXT NOT NULL,
  chain_id INTEGER,
  target_address TEXT COLLATE NOCASE,
  selector TEXT,
  transaction_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE wallet_execution_state (
  wallet_id TEXT PRIMARY KEY REFERENCES managed_wallets(id),
  state TEXT NOT NULL CHECK (state IN ('idle', 'reserved', 'submitted')),
  active_intent_id TEXT REFERENCES wallet_intents(id),
  active_nonce INTEGER,
  lease_expires_at INTEGER,
  last_observed_pending_nonce INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'idle' AND active_intent_id IS NULL AND active_nonce IS NULL AND lease_expires_at IS NULL)
    OR (state = 'reserved' AND active_intent_id IS NOT NULL AND active_nonce IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'submitted' AND active_intent_id IS NOT NULL AND active_nonce IS NOT NULL)
  )
);

CREATE TABLE wallet_intents (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'signing', 'submitted', 'confirmed', 'rejected', 'failed', 'expired')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transaction_hash TEXT, block_number INTEGER, failure_reason TEXT, idempotency_key_hash TEXT, automation_run_id TEXT REFERENCES automation_runs(id));

CREATE TABLE withdrawal_addresses (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  current_address TEXT NOT NULL COLLATE NOCASE,
  pending_address TEXT COLLATE NOCASE,
  pending_activates_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (pending_address IS NULL AND pending_activates_at IS NULL)
    OR (pending_address IS NOT NULL AND pending_activates_at IS NOT NULL)
  )
);

CREATE INDEX approval_intents_pool ON approval_intents (pool_address COLLATE NOCASE);

CREATE INDEX auth_challenges_owner_created
  ON auth_challenges(owner_address, created_at);

CREATE INDEX auth_sessions_user_expires
  ON auth_sessions(user_id, expires_at);

CREATE UNIQUE INDEX automation_mandates_live
  ON automation_mandates (wallet_id, pool_id) WHERE status != 'revoked';

CREATE INDEX automation_mandates_wallet ON automation_mandates (wallet_id);

CREATE INDEX automation_runs_mandate ON automation_runs (mandate_id, started_at);

CREATE UNIQUE INDEX automation_runs_open
  ON automation_runs (mandate_id) WHERE status IN ('proposed', 'running');

CREATE UNIQUE INDEX automation_runs_running_wallet ON automation_runs(wallet_id) WHERE status = 'running';

CREATE INDEX mainnet_execution_rehearsals_intent
  ON mainnet_execution_rehearsals(intent_id, created_at DESC);

CREATE INDEX mainnet_policy_evaluations_intent
  ON mainnet_policy_evaluations(intent_id, created_at DESC);

CREATE UNIQUE INDEX mainnet_transaction_attempts_active_wallet
  ON mainnet_transaction_attempts(wallet_id)
  WHERE status = 'submitted';

CREATE INDEX mainnet_transaction_attempts_intent
  ON mainnet_transaction_attempts(intent_id, submitted_at DESC);

CREATE INDEX mainnet_transaction_reconciliations_attempt
  ON mainnet_transaction_reconciliations(attempt_id, created_at DESC);

CREATE UNIQUE INDEX managed_wallets_dynamic_wallet_id_unique
  ON managed_wallets(dynamic_wallet_id) WHERE dynamic_wallet_id IS NOT NULL;

CREATE INDEX mint_intents_pool ON mint_intents (pool_address COLLATE NOCASE);

CREATE INDEX mint_intents_token_id ON mint_intents(token_id) WHERE token_id IS NOT NULL;

CREATE INDEX monad_nadfun_intents_pair ON monad_nadfun_intents(pair_address);

CREATE INDEX monad_nadfun_pair_directory_created ON monad_nadfun_pair_directory(created_block);

CREATE INDEX monad_nadfun_pair_directory_symbol0 ON monad_nadfun_pair_directory(token0_symbol COLLATE NOCASE);

CREATE INDEX monad_nadfun_pair_directory_symbol1 ON monad_nadfun_pair_directory(token1_symbol COLLATE NOCASE);

CREATE INDEX monad_nadfun_pair_directory_token0 ON monad_nadfun_pair_directory(token0_address);

CREATE INDEX monad_nadfun_pair_directory_token1 ON monad_nadfun_pair_directory(token1_address);

CREATE INDEX monad_swap_approval_intents_pair ON monad_swap_approval_intents(pair_id);

CREATE INDEX monad_swap_intents_pair ON monad_swap_intents(pair_id);

CREATE INDEX monad_v3_pool_directory_created ON monad_v3_pool_directory(created_block);

CREATE INDEX monad_v3_pool_directory_symbol0 ON monad_v3_pool_directory(token0_symbol COLLATE NOCASE);

CREATE INDEX monad_v3_pool_directory_symbol1 ON monad_v3_pool_directory(token1_symbol COLLATE NOCASE);

CREATE INDEX monad_v3_pool_directory_token0 ON monad_v3_pool_directory(token0_address);

CREATE INDEX monad_v3_pool_directory_token1 ON monad_v3_pool_directory(token1_address);

CREATE INDEX monad_v4_approval_pool ON monad_v4_approval_intents(pool_id);

CREATE INDEX monad_v4_mint_pool ON monad_v4_mint_intents(pool_id);

CREATE INDEX monad_v4_mint_token_id ON monad_v4_mint_intents(token_id)
  WHERE token_id IS NOT NULL;

CREATE INDEX monad_v4_pool_directory_created ON monad_v4_pool_directory(created_block);

CREATE INDEX monad_v4_pool_directory_currency0 ON monad_v4_pool_directory(currency0);

CREATE INDEX monad_v4_pool_directory_currency1 ON monad_v4_pool_directory(currency1);

CREATE INDEX monad_v4_pool_directory_symbol0 ON monad_v4_pool_directory(token0_symbol COLLATE NOCASE);

CREATE INDEX monad_v4_pool_directory_symbol1 ON monad_v4_pool_directory(token1_symbol COLLATE NOCASE);

CREATE INDEX monad_v4_position_action_pool ON monad_v4_position_action_intents(pool_id);

CREATE INDEX signing_audit_wallet_created
  ON signing_audit_log(wallet_id, created_at);

CREATE UNIQUE INDEX wallet_execution_active_intent
  ON wallet_execution_state(active_intent_id)
  WHERE active_intent_id IS NOT NULL;

CREATE INDEX wallet_intents_automation_run
  ON wallet_intents (automation_run_id) WHERE automation_run_id IS NOT NULL;

CREATE UNIQUE INDEX wallet_intents_idempotency
  ON wallet_intents(wallet_id, kind, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

CREATE INDEX wallet_intents_wallet_status
  ON wallet_intents(wallet_id, status, created_at);
