-- Wrapping native MON into WMON and back, as its own step in a swap route through a WMON pool.
CREATE TABLE monad_wrap_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('wrap', 'unwrap')),
  amount TEXT NOT NULL,
  calldata TEXT NOT NULL,
  native_value TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
