//! Rescue Room vault factory: deploys a vault subaccount (`<name>.<factory>`) for any caller, with the
//! caller as owner. Vault code is a NEAR global contract referenced by hash, so a new vault only pays
//! storage for its own state. The factory keeps a registry the defender reads to watch every vault.
//!
//! - `create_vault`: custom guardians (a council of accounts, or an existing Sputnik DAO role), safe
//!   addresses, allowance and hold tiers. Council vaults have no DAO: guardians unfreeze by quorum and
//!   the config cannot change.
//! - `create_demo_vault`: one call, pre-filled demo guardians run by the Rescue Room defender, the
//!   caller's own account as the safe address, small limits and the demo clock (1 hour = 1 minute).
//! - The caller pays only storage: the vault's state (locked in the vault) plus the registry entry.
//!   Anything attached above that funds the vault.

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

const VERSION: &str = "1.0.0";
const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
const MIN_FLOOR_SECS: u64 = 60; // shortest real hold the defender needs to score and alert
const MAX_HOLD_SECS: u64 = 7 * 86_400;
const MAX_GUARDIANS: usize = 10;
const MAX_VAULTS_PER_OWNER: usize = 20;
const ZERO_EVM: &str = "0x0000000000000000000000000000000000000000";

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "rescueroom", "version": "1.0.0", "event": event, "data": [data] })));
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Defaults {
    pub watcher: AccountId,
    pub watcher_pk: String,
    pub relayer: AccountId,
    pub mpc_contract: AccountId,
    pub evm_path: String,
    pub chain_id: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: u64,
    pub demo_guardians: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Costs {
    /// Locked in the new vault for its state and account record.
    pub vault_storage: U128,
    /// Kept by the factory for the registry entry.
    pub registry_fee: U128,
    /// What the one-click demo vault starts with (storage + reserve for the simulated attack).
    pub demo_deposit: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct VaultInfo {
    pub vault: AccountId,
    pub owner: AccountId,
    pub demo: bool,
    pub council: bool,
    pub created_ms: U64,
    pub label: String,
    pub alert_webhook: Option<String>,
}

#[near(serializers = [json])]
pub struct Tier {
    pub min_score: u8,
    pub hold_secs: u64,
}

#[near(serializers = [json])]
pub struct Setup {
    pub label: Option<String>,
    /// Council guardians. Ignored if `guardian_dao` is set (the UI reads the DAO role and passes members).
    pub guardians: Vec<AccountId>,
    pub guardian_dao: Option<AccountId>,
    pub guardian_role: Option<String>,
    pub quorum_pct: u8,
    pub min_distinct: u32,
    pub safe_near: AccountId,
    pub safe_evm: Option<String>,
    pub near_allowance: U128,
    pub near_window_secs: u64,
    pub eth_allowance: Option<U128>,
    pub hold_tiers: Vec<Tier>,
    pub hold_floor_secs: u64,
    /// true: 1 hour of policy time passes in 1 minute (for demos).
    pub demo_clock: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    vault_code: Base58CryptoHash,
    defaults: Defaults,
    costs: Costs,
    vaults: IterableMap<AccountId, VaultInfo>,
    by_owner: LookupMap<AccountId, Vec<AccountId>>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId, vault_code: Base58CryptoHash, defaults: Defaults, costs: Costs) -> Self {
        Self { owner, vault_code, defaults, costs, vaults: IterableMap::new(b"v"), by_owner: LookupMap::new(b"o") }
    }

    // ------------------------------------------------------------ create

    #[payable]
    pub fn create_vault(&mut self, name: String, setup: Setup) -> Promise {
        let caller = env::predecessor_account_id();
        let (vault, deposit) = self.precheck(&name, &caller, false);
        let council = setup.guardian_dao.is_none();
        let (config, guardians) = self.build(&vault, &caller, setup);
        self.deploy(vault, caller, deposit, config, guardians, false, council)
    }

    /// One transaction: demo guardians (run by Rescue Room), the caller as safe address, small limits,
    /// demo clock. Attach at least `costs.demo_deposit`.
    #[payable]
    pub fn create_demo_vault(&mut self, name: String) -> Promise {
        let caller = env::predecessor_account_id();
        let (vault, deposit) = self.precheck(&name, &caller, true);
        let setup = Setup {
            label: Some("Demo vault".into()),
            guardians: self.defaults.demo_guardians.clone(),
            guardian_dao: None,
            guardian_role: None,
            quorum_pct: 50,
            min_distinct: 2,
            safe_near: caller.clone(),
            safe_evm: None,
            near_allowance: U128(YOCTO * 3 / 10),
            near_window_secs: 86_400,
            eth_allowance: None,
            hold_tiers: vec![
                Tier { min_score: 0, hold_secs: 3_600 },
                Tier { min_score: 30, hold_secs: 2 * 3_600 },
                Tier { min_score: 60, hold_secs: 3 * 3_600 },
                Tier { min_score: 80, hold_secs: 6 * 3_600 },
            ],
            hold_floor_secs: 3_600,
            demo_clock: true,
        };
        let (config, guardians) = self.build(&vault, &caller, setup);
        self.deploy(vault, caller, deposit, config, guardians, true, true)
    }

    #[private]
    pub fn on_created(&mut self, info: VaultInfo, payer: AccountId, deposit: U128) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !ok {
            // The vault batch rolled back; its transfer returns to the factory. Refund the caller in full.
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(deposit.0));
            emit("vault_create_failed", json!({ "vault": info.vault, "owner": payer, "refunded": deposit }));
            return false;
        }
        let mut list = self.by_owner.get(&info.owner).cloned().unwrap_or_default();
        list.push(info.vault.clone());
        self.by_owner.insert(info.owner.clone(), list);
        emit("vault_created", json!({ "vault": info.vault, "owner": info.owner, "demo": info.demo, "council": info.council }));
        self.vaults.insert(info.vault.clone(), info);
        true
    }

    /// Vault owner sets (or clears) an https webhook the defender posts alerts to. Public on chain.
    pub fn set_alert_webhook(&mut self, vault: AccountId, url: Option<String>) {
        let mut info = self.vaults.get(&vault).cloned().unwrap_or_else(|| env::panic_str("unknown vault"));
        require!(env::predecessor_account_id() == info.owner, "only the vault owner");
        if let Some(u) = &url {
            require!(u.starts_with("https://") && u.len() <= 200 && !u.contains(char::is_whitespace), "webhook must be an https URL up to 200 chars");
        }
        info.alert_webhook = url.clone();
        self.vaults.insert(vault.clone(), info);
        emit("alert_webhook_set", json!({ "vault": vault, "set": url.is_some() }));
    }

    // ------------------------------------------------------------ owner (guardian DAO)

    pub fn set_vault_code(&mut self, vault_code: Base58CryptoHash) {
        self.only_owner();
        self.vault_code = vault_code;
        emit("vault_code_set", json!({ "hash": vault_code }));
    }

    pub fn set_costs(&mut self, costs: Costs) {
        self.only_owner();
        self.costs = costs;
    }

    pub fn set_defaults(&mut self, defaults: Defaults) {
        self.only_owner();
        self.defaults = defaults;
    }

    // ------------------------------------------------------------ views

    pub fn version(&self) -> &'static str {
        VERSION
    }

    pub fn get_costs(&self) -> Value {
        json!({
            "vault_storage": self.costs.vault_storage,
            "registry_fee": self.costs.registry_fee,
            "min_deposit": U128(self.costs.vault_storage.0 + self.costs.registry_fee.0),
            "demo_deposit": self.costs.demo_deposit,
        })
    }

    pub fn get_defaults(&self) -> &Defaults {
        &self.defaults
    }

    pub fn get_vault_code(&self) -> Base58CryptoHash {
        self.vault_code
    }

    pub fn get_owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn get_vault(&self, vault: AccountId) -> Option<VaultInfo> {
        self.vaults.get(&vault).cloned()
    }

    pub fn vaults_of(&self, owner: AccountId) -> Vec<VaultInfo> {
        self.by_owner.get(&owner).cloned().unwrap_or_default().iter().filter_map(|v| self.vaults.get(v).cloned()).collect()
    }

    pub fn list_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<VaultInfo> {
        self.vaults.values().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(100).min(200) as usize).cloned().collect()
    }

    pub fn vault_count(&self) -> u32 {
        self.vaults.len()
    }

    // ------------------------------------------------------------ internal

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
    }

    fn precheck(&self, name: &str, caller: &AccountId, demo: bool) -> (AccountId, u128) {
        require!(
            (2..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-') && !name.ends_with('-'),
            "name: 2-32 chars of a-z, 0-9 and -"
        );
        let vault: AccountId = format!("{}.{}", name, env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("bad name"));
        require!(self.vaults.get(&vault).is_none(), "name taken");
        let owned = self.by_owner.get(caller).map_or(0, |l| l.len());
        require!(owned < MAX_VAULTS_PER_OWNER, "vault limit reached for this account");
        let deposit = env::attached_deposit().as_yoctonear();
        let need = if demo { self.costs.demo_deposit.0 } else { self.costs.vault_storage.0 } + self.costs.registry_fee.0;
        require!(deposit >= need, format!("attach at least {} yoctoNEAR (vault storage + registry entry)", need));
        (vault, deposit)
    }

    fn build(&self, vault: &AccountId, owner: &AccountId, s: Setup) -> (Value, Vec<AccountId>) {
        let d = &self.defaults;
        let council = s.guardian_dao.is_none();
        let mut guardians = s.guardians;
        guardians.sort();
        guardians.dedup();
        require!(!guardians.is_empty() && guardians.len() <= MAX_GUARDIANS, "1-10 guardians");
        require!(s.min_distinct >= 1 && s.min_distinct as usize <= guardians.len(), "min_distinct must be 1..number of guardians");
        require!(s.quorum_pct >= 1 && s.quorum_pct <= 100, "quorum_pct must be 1-100");
        require!(!guardians.contains(owner), "the owner cannot be a guardian");
        require!(&s.safe_near != vault, "safe account cannot be the vault");
        let div: u64 = if s.demo_clock { 60 } else { 1 };
        require!(s.hold_floor_secs / div >= MIN_FLOOR_SECS, "hold floor must be at least 60 seconds of real time");
        require!(!s.hold_tiers.is_empty() && s.hold_tiers.len() <= 8 && s.hold_tiers[0].min_score == 0, "1-8 hold tiers, the first starting at score 0");
        let mut last = (0u8, 0u64);
        for (i, t) in s.hold_tiers.iter().enumerate() {
            require!(t.min_score <= 100 && t.hold_secs <= MAX_HOLD_SECS, "tier hold must be at most 7 days");
            if i > 0 {
                require!(t.min_score > last.0 && t.hold_secs >= last.1, "tiers: scores ascending, holds never shorter");
            }
            last = (t.min_score, t.hold_secs);
        }
        require!(s.near_window_secs >= 3_600 && s.near_window_secs <= 30 * 86_400, "allowance window: 1 hour to 30 days");
        let safe_evm = s.safe_evm.filter(|x| !x.is_empty()).unwrap_or_else(|| ZERO_EVM.to_string());
        require!(safe_evm.len() == 42 && safe_evm.starts_with("0x") && safe_evm[2..].bytes().all(|b| b.is_ascii_hexdigit()), "Sepolia safe: 0x + 40 hex");
        let max_hold = last.1.max(s.hold_floor_secs);
        let dao = s.guardian_dao.clone().unwrap_or_else(|| vault.clone());
        let config = json!({
            "owner": owner,
            "guardian_dao": dao,
            "guardian_role": s.guardian_role.unwrap_or_else(|| if council { "council-of-accounts".into() } else { "council".into() }),
            "quorum_pct": s.quorum_pct,
            "min_distinct": s.min_distinct,
            "watcher": d.watcher,
            "watcher_pk": d.watcher_pk,
            "relayer": d.relayer,
            "safe_near": s.safe_near,
            "safe_evm": safe_evm,
            "near_allowance": { "limit": s.near_allowance, "window_secs": s.near_window_secs },
            "eth_allowance": { "limit": s.eth_allowance.unwrap_or(U128(0)), "window_secs": s.near_window_secs },
            "hold_tiers": s.hold_tiers,
            "hold_floor_secs": s.hold_floor_secs,
            "unscored_hold_secs": max_hold,
            "evm": { "mpc_contract": d.mpc_contract, "path": d.evm_path, "chain_id": d.chain_id, "max_fee_per_gas": d.max_fee_per_gas, "max_priority_fee_per_gas": d.max_priority_fee_per_gas, "gas_limit": d.gas_limit },
            "cover": { "base_premium_bps": 200, "per_incident_cap": U128(YOCTO), "term_secs": 30 * 86_400 },
            "demo_time_divisor": div,
        });
        let _ = s.label;
        (config, guardians)
    }

    #[allow(clippy::too_many_arguments)]
    fn deploy(&mut self, vault: AccountId, caller: AccountId, deposit: u128, config: Value, guardians: Vec<AccountId>, demo: bool, council: bool) -> Promise {
        let to_vault = deposit - self.costs.registry_fee.0;
        let code: [u8; 32] = self.vault_code.into();
        let info = VaultInfo { vault: vault.clone(), owner: caller.clone(), demo, council, created_ms: U64(env::block_timestamp_ms()), label: if demo { "Demo vault".into() } else { "Vault".into() }, alert_webhook: None };
        Promise::new(vault)
            .create_account()
            .transfer(NearToken::from_yoctonear(to_vault))
            .use_global_contract(code)
            .function_call("new", json!({ "config": config, "guardians": guardians }).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(30))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_created",
                    json!({ "info": info, "payer": caller, "deposit": U128(deposit) }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(20),
                ),
            )
    }
}

#[cfg(test)]
mod tests;
