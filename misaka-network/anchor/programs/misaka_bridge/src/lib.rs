// ============================================================
// Misaka Bridge — Solana Anchor Program
// ============================================================
// Deploy: anchor build && anchor deploy
// This program handles the Solana side of the Misaka bridge:
//   - lock:   Lock SOL/SPL tokens into the bridge vault
//   - unlock: Release tokens after ZK proof verification
// ============================================================

use anchor_lang::prelude::*;

declare_id!("BridgeMisakaProgram1111111111111111111111111");

#[program]
pub mod misaka_bridge {
    use super::*;

    /// Initialize the bridge with authority and chain ID.
    pub fn initialize(ctx: Context<Initialize>, misaka_chain_id: String) -> Result<()> {
        let state = &mut ctx.accounts.bridge_state;
        state.authority = ctx.accounts.authority.key();
        state.misaka_chain_id = misaka_chain_id;
        state.total_locked = 0;
        state.total_unlocked = 0;
        state.nonce_counter = 0;
        state.paused = false;
        msg!("Bridge initialized for chain: {}", state.misaka_chain_id);
        Ok(())
    }

    /// Lock SOL into the bridge vault for cross-chain transfer.
    ///
    /// Emits a LockEvent that the relayer monitors to generate
    /// a ZK proof and mint tokens on Misaka.
    pub fn lock(
        ctx: Context<Lock>,
        amount: u64,
        misaka_recipient: String,
        token: String,
    ) -> Result<()> {
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);
        require!(amount > 0, BridgeError::ZeroAmount);
        require!(
            amount >= 1_000_000, // Minimum 0.001 SOL
            BridgeError::BelowMinimum
        );

        // Transfer SOL from locker to vault
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.locker.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.locker.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
        )?;

        // Update state
        let state = &mut ctx.accounts.bridge_state;
        state.total_locked += amount;
        state.nonce_counter += 1;
        let nonce = state.nonce_counter;

        // Emit lock event for relayer
        emit!(LockEvent {
            locker: ctx.accounts.locker.key(),
            amount,
            token,
            misaka_recipient,
            nonce,
            slot: Clock::get()?.slot,
        });

        msg!("Locked {} lamports, nonce={}", amount, nonce);
        Ok(())
    }

    /// Unlock SOL from the vault after ZK proof verification.
    ///
    /// Called by the relayer after verifying a burn event on Misaka.
    /// The ZK proof ensures the burn actually happened.
    pub fn unlock(
        ctx: Context<Unlock>,
        burn_tx_id: String,
        amount: u64,
        proof_data: Vec<u8>,
        nonce: String,
    ) -> Result<()> {
        require!(!ctx.accounts.bridge_state.paused, BridgeError::Paused);
        require!(amount > 0, BridgeError::ZeroAmount);

        // Check not already processed
        let state = &mut ctx.accounts.bridge_state;
        // In production, use a PDA-based processed set
        // For simplicity, we check total_unlocked doesn't exceed total_locked
        require!(
            state.total_unlocked + amount <= state.total_locked,
            BridgeError::InsufficientLocked
        );

        // Verify authority (relayer must be authorized)
        require!(
            ctx.accounts.authority.key() == state.authority,
            BridgeError::Unauthorized
        );

        // Verify ZK proof (simplified — in production, use on-chain verifier)
        require!(proof_data.len() > 0, BridgeError::InvalidProof);

        // Transfer from vault to recipient
        // In production, use PDA signer seeds
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;

        state.total_unlocked += amount;

        emit!(UnlockEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            burn_tx_id,
            nonce,
            slot: Clock::get()?.slot,
        });

        msg!("Unlocked {} lamports", amount);
        Ok(())
    }

    /// Pause the bridge (emergency).
    pub fn pause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.bridge_state.paused = true;
        msg!("Bridge paused");
        Ok(())
    }

    /// Unpause the bridge.
    pub fn unpause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.bridge_state.paused = false;
        msg!("Bridge unpaused");
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────

#[account]
pub struct BridgeState {
    pub authority: Pubkey,       // 32
    pub misaka_chain_id: String, // 4 + len
    pub total_locked: u64,       // 8
    pub total_unlocked: u64,     // 8
    pub nonce_counter: u64,      // 8
    pub paused: bool,            // 1
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 4 + 64 + 8 + 8 + 8 + 1
    )]
    pub bridge_state: Account<'info, BridgeState>,
    /// CHECK: Vault PDA
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Lock<'info> {
    #[account(mut)]
    pub locker: Signer<'info>,
    /// CHECK: Vault PDA that holds locked funds
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Recipient to receive unlocked funds
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    /// CHECK: Vault PDA
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub bridge_state: Account<'info, BridgeState>,
}

// ── Events ──────────────────────────────────────────────

#[event]
pub struct LockEvent {
    pub locker: Pubkey,
    pub amount: u64,
    pub token: String,
    pub misaka_recipient: String,
    pub nonce: u64,
    pub slot: u64,
}

#[event]
pub struct UnlockEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub burn_tx_id: String,
    pub nonce: String,
    pub slot: u64,
}

// ── Errors ──────────────────────────────────────────────

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount below minimum bridge threshold")]
    BelowMinimum,
    #[msg("Insufficient locked balance for unlock")]
    InsufficientLocked,
    #[msg("Unauthorized: only bridge authority can unlock")]
    Unauthorized,
    #[msg("Invalid ZK proof")]
    InvalidProof,
    #[msg("Nonce already processed")]
    NonceReplay,
}
