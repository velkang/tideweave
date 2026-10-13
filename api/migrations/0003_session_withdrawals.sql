-- Withdrawals are sends authorized by the signed-in session, like every other action, so the
-- owner's separate EIP-712 signature is no longer stored.
ALTER TABLE monad_withdrawal_intents DROP COLUMN owner_signature;
ALTER TABLE monad_withdrawal_intents DROP COLUMN owner_address;
ALTER TABLE monad_withdrawal_intents RENAME COLUMN signature_expires_at TO expires_at;
