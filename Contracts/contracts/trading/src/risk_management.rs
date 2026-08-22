use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol, Map};

/// Risk tier classification based on KYC status and account age
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RiskTier {
    /// Basic: No KYC, new account (< 30 days)
    Basic = 0,
    /// Verified: Basic KYC, account age > 30 days
    Verified = 1,
    /// Enhanced: Enhanced KYC, account age > 90 days
    Enhanced = 2,
    /// Institutional: Full KYC + institutional verification
    Institutional = 3,
}

/// Risk tier configuration for a specific tier
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskTierConfig {
    /// Maximum position size (in base token units)
    pub max_position_size: i128,
    /// Daily volume cap (in base token units)
    pub daily_volume_cap: i128,
    /// Maximum slippage tolerance (in basis points, 10000 = 100%)
    pub max_slippage_bps: u32,
    /// Minimum liquidity threshold (in base token units)
    pub min_liquidity_threshold: i128,
    /// Maximum trade size (in base token units)
    pub max_trade_size: i128,
}

/// User risk profile
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserRiskProfile {
    pub user: Address,
    pub tier: RiskTier,
    pub account_created_at: u64,
    pub kyc_level: Symbol,
    pub daily_volume_used: i128,
    pub daily_volume_window_start: u64,
    pub current_position_size: i128,
}

/// Risk metadata for compliance auditing
#[contracttype]
#[derive(Clone, Debug)]
pub struct RiskMetadata {
    pub user_tier: RiskTier,
    pub position_limit: i128,
    pub volume_cap: i128,
    pub slippage_limit_bps: u32,
    pub liquidity_check_passed: bool,
    pub circuit_breaker_check_passed: bool,
}

/// Liquidity check result
#[contracttype]
#[derive(Clone, Debug)]
pub struct LiquidityCheck {
    pub pool_liquidity: i128,
    pub trade_amount: i128,
    pub post_trade_liquidity: i128,
    pub threshold: i128,
    pub passed: bool,
}

/// Circuit breaker configuration with tier-specific thresholds
#[derive(Clone, Debug)]
pub struct TieredCircuitBreakerConfig {
    /// Price volatility threshold per tier (in basis points)
    pub volatility_thresholds: Map<u32, u32>,
    /// Volume surge multiplier per tier
    pub volume_surge_multipliers: Map<u32, u32>,
    /// Observation window in seconds
    pub observation_window_secs: u64,
}

/// Circuit breaker state with tier-specific tracking
#[derive(Clone, Debug)]
pub struct TieredCircuitBreakerState {
    pub last_price: i128,
    pub last_price_timestamp: u64,
    pub triggered_tier: Option<u32>,
    pub trigger_reason: Symbol,
    pub triggered_at: u64,
}

impl RiskTier {
    /// Get default configuration for a risk tier
    pub fn default_config(_env: &Env, tier: RiskTier) -> RiskTierConfig {
        match tier {
            RiskTier::Basic => RiskTierConfig {
                max_position_size: 1_000_000,
                daily_volume_cap: 5_000_000,
                max_slippage_bps: 100, // 1%
                min_liquidity_threshold: 10_000_000,
                max_trade_size: 100_000,
            },
            RiskTier::Verified => RiskTierConfig {
                max_position_size: 5_000_000,
                daily_volume_cap: 25_000_000,
                max_slippage_bps: 200, // 2%
                min_liquidity_threshold: 5_000_000,
                max_trade_size: 500_000,
            },
            RiskTier::Enhanced => RiskTierConfig {
                max_position_size: 25_000_000,
                daily_volume_cap: 100_000_000,
                max_slippage_bps: 300, // 3%
                min_liquidity_threshold: 2_500_000,
                max_trade_size: 2_500_000,
            },
            RiskTier::Institutional => RiskTierConfig {
                max_position_size: 100_000_000,
                daily_volume_cap: 500_000_000,
                max_slippage_bps: 500, // 5%
                min_liquidity_threshold: 1_000_000,
                max_trade_size: 10_000_000,
            },
        }
    }

    /// Determine risk tier based on KYC level and account age
    pub fn from_kyc_and_age(kyc_level: &Symbol, account_age_days: u64) -> RiskTier {
        let basic_kyc = symbol_short!("basic");
        let enhanced_kyc = symbol_short!("enhanced");
        let institutional_kyc = symbol_short!("inst");

        match (kyc_level, account_age_days) {
            (level, _) if *level == institutional_kyc => RiskTier::Institutional,
            (level, age) if *level == enhanced_kyc && age >= 90 => RiskTier::Institutional,
            (level, age) if *level == enhanced_kyc && age >= 30 => RiskTier::Enhanced,
            (level, age) if *level == basic_kyc && age >= 30 => RiskTier::Verified,
            _ => RiskTier::Basic,
        }
    }
}

pub struct RiskManager;

impl RiskManager {
    const USER_RISK_KEY: Symbol = symbol_short!("usr_risk");
    const TIER_CONFIG_KEY: Symbol = symbol_short!("tier_cfg");
    const CB_CONFIG_KEY: Symbol = symbol_short!("cb_cfg");
    const CB_STATE_KEY: Symbol = symbol_short!("cb_st");

    /// Initialize risk manager with tier configurations
    pub fn init(env: &Env) {
        let mut tier_configs: Map<RiskTier, RiskTierConfig> = Map::new(env);
        
        for tier in [RiskTier::Basic, RiskTier::Verified, RiskTier::Enhanced, RiskTier::Institutional] {
            tier_configs.set(tier, RiskTier::default_config(env, tier));
        }
        
        env.storage().persistent().set(&Self::TIER_CONFIG_KEY, &tier_configs);

        // Initialize tiered circuit breaker config
        let mut volatility_thresholds: Map<u32, u32> = Map::new(env);
        volatility_thresholds.set(0, 50); // 0.5% for Basic
        volatility_thresholds.set(1, 100); // 1% for Verified
        volatility_thresholds.set(2, 200); // 2% for Enhanced
        volatility_thresholds.set(3, 500); // 5% for Institutional

        let mut volume_multipliers: Map<u32, u32> = Map::new(env);
        volume_multipliers.set(0, 200); // 2x for Basic
        volume_multipliers.set(1, 300); // 3x for Verified
        volume_multipliers.set(2, 500); // 5x for Enhanced
        volume_multipliers.set(3, 1000); // 10x for Institutional

        let cb_config = TieredCircuitBreakerConfig {
            volatility_thresholds,
            volume_surge_multipliers: volume_multipliers,
            observation_window_secs: 300, // 5 minutes
        };

        env.storage().persistent().set(&Self::CB_CONFIG_KEY, &cb_config);

        let cb_state = TieredCircuitBreakerState {
            last_price: 0,
            last_price_timestamp: 0,
            triggered_tier: None,
            trigger_reason: symbol_short!("none"),
            triggered_at: 0,
        };

        env.storage().persistent().set(&Self::CB_STATE_KEY, &cb_state);
    }

    /// Get or create user risk profile
    pub fn get_user_profile(env: &Env, user: &Address) -> UserRiskProfile {
        let key = (Self::USER_RISK_KEY, user.clone());
        if let Some(profile) = env.storage().persistent().get(&key) {
            profile
        } else {
            // Create default profile for new user
            let now = env.ledger().timestamp();
            UserRiskProfile {
                user: user.clone(),
                tier: RiskTier::Basic,
                account_created_at: now,
                kyc_level: symbol_short!("none"),
                daily_volume_used: 0,
                daily_volume_window_start: now,
                current_position_size: 0,
            }
        }
    }

    /// Update user risk profile
    pub fn update_user_profile(env: &Env, user: &Address, profile: UserRiskProfile) {
        let key = (Self::USER_RISK_KEY, user.clone());
        env.storage().persistent().set(&key, &profile);
    }

    /// Update user KYC level and recalculate tier
    pub fn update_kyc_level(env: &Env, user: &Address, kyc_level: Symbol) -> RiskTier {
        let mut profile = Self::get_user_profile(env, user);
        profile.kyc_level = kyc_level;
        
        let now = env.ledger().timestamp();
        let account_age_days = (now - profile.account_created_at) / 86400;
        
        let new_tier = RiskTier::from_kyc_and_age(&profile.kyc_level, account_age_days);
        profile.tier = new_tier;
        Self::update_user_profile(env, user, profile);
        
        new_tier
    }

    /// Get tier configuration
    pub fn get_tier_config(env: &Env, tier: RiskTier) -> RiskTierConfig {
        let tier_configs: Map<RiskTier, RiskTierConfig> = env
            .storage()
            .persistent()
            .get(&Self::TIER_CONFIG_KEY)
            .expect("Risk manager not initialized");
        
        tier_configs.get(tier).expect("Tier config not found")
    }

    /// Check if trade respects position limits
    pub fn check_position_limit(env: &Env, user: &Address, trade_amount: i128) -> bool {
        let profile = Self::get_user_profile(env, user);
        let config = Self::get_tier_config(env, profile.tier);
        
        let new_position = profile.current_position_size + trade_amount;
        new_position <= config.max_position_size
    }

    /// Check if trade respects daily volume cap
    pub fn check_daily_volume(env: &Env, user: &Address, trade_amount: i128) -> bool {
        let mut profile = Self::get_user_profile(env, user);
        let config = Self::get_tier_config(env, profile.tier);
        
        let now = env.ledger().timestamp();
        let day_secs = 86400;
        
        // Reset daily volume if window expired
        if now >= profile.daily_volume_window_start + day_secs {
            profile.daily_volume_used = 0;
            profile.daily_volume_window_start = now;
            Self::update_user_profile(env, user, profile.clone());
        }
        
        profile.daily_volume_used + trade_amount <= config.daily_volume_cap
    }

    /// Consume daily volume quota
    pub fn consume_daily_volume(env: &Env, user: &Address, trade_amount: i128) {
        let mut profile = Self::get_user_profile(env, user);
        profile.daily_volume_used += trade_amount;
        Self::update_user_profile(env, user, profile);
    }

    /// Update user position size
    pub fn update_position_size(env: &Env, user: &Address, delta: i128) {
        let mut profile = Self::get_user_profile(env, user);
        profile.current_position_size += delta;
        Self::update_user_profile(env, user, profile);
    }

    /// Perform liquidity check for a trade
    pub fn check_liquidity(
        env: &Env,
        user: &Address,
        pool_liquidity: i128,
        trade_amount: i128,
    ) -> LiquidityCheck {
        let profile = Self::get_user_profile(env, user);
        let config = Self::get_tier_config(env, profile.tier);
        
        let post_trade_liquidity = pool_liquidity - trade_amount;
        let passed = post_trade_liquidity >= config.min_liquidity_threshold;
        
        LiquidityCheck {
            pool_liquidity,
            trade_amount,
            post_trade_liquidity,
            threshold: config.min_liquidity_threshold,
            passed,
        }
    }

    /// Check circuit breaker based on price volatility
    pub fn check_circuit_breaker(env: &Env, user: &Address, current_price: i128) -> bool {
        let profile = Self::get_user_profile(env, user);
        let cb_config: TieredCircuitBreakerConfig = env
            .storage()
            .persistent()
            .get(&Self::CB_CONFIG_KEY)
            .expect("Circuit breaker not initialized");
        
        let mut cb_state: TieredCircuitBreakerState = env
            .storage()
            .persistent()
            .get(&Self::CB_STATE_KEY)
            .expect("Circuit breaker state not found");
        
        // If already triggered, check if cooldown period passed
        if cb_state.triggered_tier.is_some() {
            let now = env.ledger().timestamp();
            let cooldown_secs = 3600; // 1 hour cooldown
            if now < cb_state.triggered_at + cooldown_secs {
                return false;
            }
            // Reset after cooldown
            cb_state.triggered_tier = None;
            cb_state.trigger_reason = symbol_short!("none");
        }
        
        // Check price volatility
        let now = env.ledger().timestamp();
        if cb_state.last_price > 0 && now < cb_state.last_price_timestamp + cb_config.observation_window_secs {
            let threshold_bps = cb_config.volatility_thresholds
                .get(profile.tier as u32)
                .unwrap_or(100);
            
            let price_change = ((current_price - cb_state.last_price) * 10000) / cb_state.last_price;
            let price_change_abs = if price_change < 0 { -price_change } else { price_change };
            
            if price_change_abs > threshold_bps as i128 {
                cb_state.triggered_tier = Some(profile.tier as u32);
                cb_state.trigger_reason = symbol_short!("vol");
                cb_state.triggered_at = now;
                env.storage().persistent().set(&Self::CB_STATE_KEY, &cb_state);
                return false;
            }
        }
        
        // Update last price
        cb_state.last_price = current_price;
        cb_state.last_price_timestamp = now;
        env.storage().persistent().set(&Self::CB_STATE_KEY, &cb_state);
        
        true
    }

    /// Generate risk metadata for a trade
    pub fn generate_risk_metadata(
        env: &Env,
        user: &Address,
        pool_liquidity: i128,
        trade_amount: i128,
        current_price: i128,
    ) -> RiskMetadata {
        let profile = Self::get_user_profile(env, user);
        let config = Self::get_tier_config(env, profile.tier);
        
        let liquidity_check = Self::check_liquidity(env, user, pool_liquidity, trade_amount);
        let cb_check = Self::check_circuit_breaker(env, user, current_price);
        
        RiskMetadata {
            user_tier: profile.tier,
            position_limit: config.max_position_size,
            volume_cap: config.daily_volume_cap,
            slippage_limit_bps: config.max_slippage_bps,
            liquidity_check_passed: liquidity_check.passed,
            circuit_breaker_check_passed: cb_check,
        }
    }

    /// Get circuit breaker state
    pub fn get_circuit_breaker_state(env: &Env) -> TieredCircuitBreakerState {
        env.storage()
            .persistent()
            .get(&Self::CB_STATE_KEY)
            .expect("Circuit breaker state not found")
    }

    /// Reset circuit breaker (admin only)
    pub fn reset_circuit_breaker(env: &Env) {
        let cb_state = TieredCircuitBreakerState {
            last_price: 0,
            last_price_timestamp: 0,
            triggered_tier: None,
            trigger_reason: symbol_short!("none"),
            triggered_at: 0,
        };
        env.storage().persistent().set(&Self::CB_STATE_KEY, &cb_state);
    }

    /// Update tier configuration (admin only)
    pub fn update_tier_config(env: &Env, tier: RiskTier, config: RiskTierConfig) {
        let mut tier_configs: Map<RiskTier, RiskTierConfig> = env
            .storage()
            .persistent()
            .get(&Self::TIER_CONFIG_KEY)
            .expect("Risk manager not initialized");
        
        tier_configs.set(tier, config);
        env.storage().persistent().set(&Self::TIER_CONFIG_KEY, &tier_configs);
    }
}
