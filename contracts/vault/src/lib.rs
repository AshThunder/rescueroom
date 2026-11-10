//! Rescue Room vault: a safety layer for DAO treasuries and AI agents.
//!
//! - Hot allowance: small spends within a rolling window execute instantly.
//! - Everything beyond the allowance is held. The hold length comes from a risk score
//!   (0-100) submitted by an off-chain watcher that signs its evidence bundle.
//!   The watcher only recommends; it can never move funds.
//! - The owner can cancel any held request instantly.
//! - Guardians (synced from a Sputnik DAO role) can vote to rescue: the request is
//!   blocked and vault funds move to a pre-set safe address. The DAO itself can also
//!   rescue through a FunctionCall proposal.
//! - Sepolia ETH is controlled through NEAR chain signatures (MPC signer).
//! - A small cover pool prices premiums by risk, caps payouts per incident and
//!   reports live solvency.
//! - Every state change is emitted as a NEP-297 event.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PublicKey,
};

pub mod evm;

const EVENT_STANDARD: &str = "rescueroom";
const VERSION: &str = match option_env!("RR_VERSION") {
    Some(v) => v,
    None => "1.2.0",
};
const EVENT_VERSION: &str = "1.0.0";
/// broadcast_hash marker for a signed tx replaced by `dao_resync_evm_nonce`.
pub const SUPERSEDED: &str = "superseded";
const MS: u64 = 1_000;
const NEAR_BUFFER: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR kept for gas/storage
const AGENT_KEY_ALLOWANCE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR of gas

// ---------------------------------------------------------------- types

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Asset {
    Near,
    SepoliaEth,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    /// Beyond allowance, waiting for a watcher score (unscored hold applies).
    PendingScore,
    /// Scored, waiting for the hold to expire.
    Held,
    /// NEAR transfer or MPC signature in flight.
    Executing,
    /// NEAR sent, or Sepolia tx signed and ready for the relayer.
    Executed,
    Cancelled,
    Rescued,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct HoldTier {
    pub min_score: u8,
    pub hold_secs: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AllowanceCfg {
    pub limit: U128,
    pub window_secs: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvmCfg {
    pub mpc_contract: AccountId,
    pub path: String,
    pub chain_id: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct CoverCfg {
    pub base_premium_bps: u32,
    pub per_incident_cap: U128,
    pub term_secs: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub guardian_dao: AccountId,
    /// Name of the Sputnik role whose members are guardians (e.g. "council").
    pub guardian_role: String,
    /// Percentage of the guardian set that must approve a rescue.
    pub quorum_pct: u8,
    /// Absolute floor of distinct approvers, regardless of set size.
    pub min_distinct: u32,
    pub watcher: AccountId,
    /// ed25519 key the watcher signs evidence bundles with ("ed25519:...").
    pub watcher_pk: PublicKey,
    pub relayer: AccountId,
    pub safe_near: AccountId,
    pub safe_evm: String,
    pub near_allowance: AllowanceCfg,
    pub eth_allowance: AllowanceCfg,
    pub hold_tiers: Vec<HoldTier>,
    /// Minimum hold for anything beyond the allowance, even if the watcher scores 0.
    pub hold_floor_secs: u64,
    /// Hold applied before (or without) a watcher score.
    pub unscored_hold_secs: u64,
    pub evm: EvmCfg,
    pub cover: CoverCfg,
    /// 1 = real time. 60 = demo mode (an "hour" tier lasts a minute).
    pub demo_time_divisor: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Signal {
    pub code: String,
    pub weight: u8,
    pub detail: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Score {
    pub score: u8,
    pub confidence: u8,
    pub evidence_hash: String,
    pub signals: Vec<Signal>,
    pub scored_at_ms: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: u64,
    pub to: String,
    pub value: U128,
    /// keccak256 of the unsigned typed tx: the payload the MPC signed.
    pub payload_hex: String,
    pub unsigned_hex: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct MpcSignature {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Request {
    pub id: u64,
    pub asset: Asset,
    pub to: String,
    pub amount: U128,
    pub memo: String,
    pub requester: AccountId,
    /// Label of the agent key that made the request, if any.
    pub agent: Option<String>,
    /// Public key of that agent key (revoked automatically on rescue).
    pub agent_pk: Option<String>,
    pub created_ms: U64,
    pub release_ms: U64,
    pub hot: bool,
    pub status: Status,
    pub score: Option<Score>,
    pub approvals: Vec<AccountId>,
    pub evm_tx: Option<EvmTx>,
    pub signature: Option<MpcSignature>,
    pub broadcast_hash: Option<String>,
    pub resolved_by: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AgentInfo {
    pub label: String,
    pub added_ms: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct WindowState {
    pub start_ms: u64,
    pub spent: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    pub id: u64,
    pub holder: AccountId,
    pub coverage: U128,
    pub premium: U128,
    pub start_ms: U64,
    pub end_ms: U64,
    pub paid_out: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimStatus {
    Pending,
    Paid,
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub id: u64,
    pub policy_id: u64,
    pub amount: U128,
    pub request_id: Option<u64>,
    pub reason: String,
    pub status: ClaimStatus,
    pub approvals: Vec<AccountId>,
    pub payout: U128,
}

// MPC signer interface (v1.signer-prod.testnet, contract v3.x).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ScalarHex {
    pub scalar: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub big_r: AffinePoint,
    pub s: ScalarHex,
    pub recovery_id: u8,
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
}

#[ext_contract(ext_dao)]
pub trait SputnikDao {
    fn get_policy(&self) -> Value;
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn on_near_sent(&mut self, id: u64, rescue: bool);
    fn on_signed(&mut self, id: u64);
    fn on_policy(&mut self);
    fn on_claim_paid(&mut self, claim_id: u64);
}

#[near(serializers = [json])]
pub struct VaultStatus {
    pub near_balance: U128,
    pub near_available: U128,
    pub near_hot_remaining: U128,
    pub eth_hot_remaining: U128,
    pub frozen: bool,
    pub next_request_id: u64,
    pub evm_nonce: u64,
    pub guardians: Vec<AccountId>,
    pub approvals_needed: u32,
    pub rescues: u32,
}

#[near(serializers = [json])]
pub struct CoverStats {
    pub pool_balance: U128,
    pub active_exposure: U128,
    /// pool / exposure in basis points (10000 = 100%). u32::MAX when no exposure.
    pub solvency_bps: u32,
    pub risk_points: u32,
    pub premium_bps: u32,
    pub active_policies: u32,
    pub per_incident_cap: U128,
}

// ---------------------------------------------------------------- state

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    config: Config,
    guardians: Vec<AccountId>,
    requests: LookupMap<u64, Request>,
    next_id: u64,
    whitelist: IterableMap<String, u64>,
    agents: IterableMap<String, AgentInfo>,
    near_window: WindowState,
    eth_window: WindowState,
    frozen: bool,
    evm_nonce: u64,
    rescues: u32,
    recent_scores: Vec<u8>,
    pool_balance: u128,
    policies: Vector<Policy>,
    claims: Vector<Claim>,
    underwriters: IterableMap<AccountId, u128>,
    /// Requests still on hold. A rescue blocks all of them, not just the one voted on.
    open_ids: IterableSet<u64>,
}

fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", log));
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// Message the watcher signs. Binds vault, request, score and evidence together.
pub fn score_message(vault: &str, id: u64, score: u8, confidence: u8, evidence_hash: &str) -> String {
    format!("rescueroom-score:v1:{vault}:{id}:{score}:{confidence}:{evidence_hash}")
}

#[near]
impl Vault {
    #[init]
    pub fn new(config: Config, guardians: Vec<AccountId>) -> Self {
        Self::validate(&config);
        let s = Self {
            config,
            guardians,
            requests: LookupMap::new(b"r"),
            next_id: 0,
            whitelist: IterableMap::new(b"w"),
            agents: IterableMap::new(b"a"),
            near_window: WindowState::default(),
            eth_window: WindowState::default(),
            frozen: false,
            evm_nonce: 0,
            rescues: 0,
            recent_scores: vec![],
            pool_balance: 0,
            policies: Vector::new(b"p"),
            claims: Vector::new(b"c"),
            underwriters: IterableMap::new(b"u"),
            open_ids: IterableSet::new(b"o"),
        };
        emit("vault_created", json!({ "owner": s.config.owner, "guardian_dao": s.config.guardian_dao }));
        s
    }

    fn validate(c: &Config) {
        require!(c.quorum_pct > 0 && c.quorum_pct <= 100, "quorum_pct must be 1-100");
        require!(c.min_distinct >= 1, "min_distinct must be >= 1");
        require!(!c.hold_tiers.is_empty(), "need hold tiers");
        require!(c.hold_tiers[0].min_score == 0, "first tier must start at 0");
        for w in c.hold_tiers.windows(2) {
            require!(w[0].min_score < w[1].min_score, "tiers must be ascending");
            require!(w[0].hold_secs <= w[1].hold_secs, "holds must not shrink with risk");
        }
        require!(evm::parse_address(&c.safe_evm).is_some(), "bad safe_evm");
        require!(c.demo_time_divisor >= 1, "divisor >= 1");
        require!(c.unscored_hold_secs >= c.hold_floor_secs, "unscored hold must be >= hold floor");
    }

    // ------------------------------------------------------------ requests

    /// Ask to move funds. Owner, or an agent function-call key on this account.
    /// Within the hot allowance: executes now. Beyond it: held until scored + hold.
    pub fn request_withdraw(&mut self, asset: Asset, to: String, amount: U128, memo: Option<String>) -> u64 {
        require!(!self.frozen, "vault is frozen after a rescue");
        let (requester, agent, agent_pk) = self.auth_requester();
        require!(amount.0 > 0, "amount must be > 0");
        match asset {
            Asset::Near => {
                require!(to.parse::<AccountId>().is_ok(), "bad NEAR account");
            }
            Asset::SepoliaEth => {
                require!(evm::parse_address(&to).is_some(), "bad EVM address");
            }
        }
        let now = now_ms();
        let hot = self.try_spend_allowance(asset, amount.0, now);
        let id = self.next_id;
        self.next_id += 1;
        let release = if hot { now } else { now + self.scaled(self.config.unscored_hold_secs) * MS };
        let req = Request {
            id,
            asset,
            to: to.to_lowercase(),
            amount,
            memo: memo.unwrap_or_default().chars().take(140).collect(),
            requester: requester.clone(),
            agent: agent.clone(),
            agent_pk,
            created_ms: U64(now),
            release_ms: U64(release),
            hot,
            status: if hot { Status::Executing } else { Status::PendingScore },
            score: None,
            approvals: vec![],
            evm_tx: None,
            signature: None,
            broadcast_hash: None,
            resolved_by: None,
        };
        emit(
            "withdraw_requested",
            json!({ "id": id, "asset": asset, "to": req.to, "amount": amount, "requester": requester,
                    "agent": agent, "hot": hot, "release_ms": U64(release) }),
        );
        self.requests.insert(id, req);
        if hot {
            self.dispatch(id, false);
        } else {
            self.open_ids.insert(id);
        }
        id
    }

    /// Watcher posts a risk score with a signed evidence bundle hash.
    pub fn submit_score(
        &mut self,
        id: u64,
        score: u8,
        confidence: u8,
        evidence_hash: String,
        signals: Vec<Signal>,
        signature: String,
    ) {
        require!(env::predecessor_account_id() == self.config.watcher, "only watcher");
        require!(score <= 100 && confidence <= 100, "score/confidence 0-100");
        require!(evidence_hash.len() == 64 && hex::decode(&evidence_hash).is_ok(), "evidence_hash: 32-byte hex");
        require!(signals.len() <= 12, "too many signals");
        let msg = score_message(env::current_account_id().as_str(), id, score, confidence, &evidence_hash);
        let sig_bytes: [u8; 64] = hex::decode(&signature)
            .ok()
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("signature: 64-byte hex"));
        let pk_bytes: [u8; 32] = self.config.watcher_pk.as_bytes()[1..]
            .try_into()
            .unwrap_or_else(|_| env::panic_str("watcher_pk must be ed25519"));
        require!(env::ed25519_verify(&sig_bytes, msg.as_bytes(), &pk_bytes), "bad evidence signature");

        let mut req = self.get_req(id);
        let hold = self.hold_for(score);
        if req.status == Status::PendingScore {
            req.release_ms = U64(req.created_ms.0 + hold * MS);
            req.status = Status::Held;
        }
        req.score = Some(Score {
            score,
            confidence,
            evidence_hash: evidence_hash.clone(),
            signals: signals.clone(),
            scored_at_ms: U64(now_ms()),
        });
        self.recent_scores.push(score);
        if self.recent_scores.len() > 10 {
            self.recent_scores.remove(0);
        }
        emit(
            "risk_scored",
            json!({ "id": id, "score": score, "confidence": confidence, "evidence_hash": evidence_hash,
                    "signals": signals, "hold_secs": hold, "release_ms": req.release_ms, "status": req.status }),
        );
        self.requests.insert(id, req);
    }

    /// Anyone may execute a request once its hold has passed.
    pub fn execute(&mut self, id: u64) {
        require!(!self.frozen, "vault is frozen after a rescue");
        let mut req = self.get_req(id);
        require!(matches!(req.status, Status::PendingScore | Status::Held), "not executable");
        require!(now_ms() >= req.release_ms.0, "still on hold");
        req.status = Status::Executing;
        self.requests.insert(id, req);
        self.open_ids.remove(&id);
        emit("execute_started", json!({ "id": id }));
        self.dispatch(id, false);
    }

    /// Owner cancels a held request instantly.
    pub fn cancel(&mut self, id: u64) {
        require!(env::predecessor_account_id() == self.config.owner, "only owner");
        let mut req = self.get_req(id);
        require!(matches!(req.status, Status::PendingScore | Status::Held), "not cancellable");
        req.status = Status::Cancelled;
        req.resolved_by = Some(env::predecessor_account_id());
        self.requests.insert(id, req);
        self.open_ids.remove(&id);
        emit("request_cancelled", json!({ "id": id, "by": env::predecessor_account_id(), "reason": "owner" }));
    }

    // ------------------------------------------------------------ guardians

    /// A guardian votes to rescue a request. On quorum + distinct floor the request is
    /// blocked, vault funds move to the safe address and the vault freezes.
    pub fn vote_rescue(&mut self, id: u64) {
        let voter = env::predecessor_account_id();
        require!(self.guardians.contains(&voter), "not a guardian");
        let mut req = self.get_req(id);
        require!(
            matches!(req.status, Status::PendingScore | Status::Held),
            "request is not on hold"
        );
        require!(!req.approvals.contains(&voter), "already voted");
        req.approvals.push(voter.clone());
        let count = req.approvals.len() as u32;
        let needed = self.approvals_needed();
        self.requests.insert(id, req);
        emit("rescue_vote", json!({ "id": id, "guardian": voter, "approvals": count, "needed": needed }));
        if count >= needed {
            self.do_rescue(id, voter);
        }
    }

    /// The guardian DAO itself rescues via an approved FunctionCall proposal.
    pub fn dao_rescue(&mut self, id: u64) {
        self.only_dao();
        let req = self.get_req(id);
        require!(matches!(req.status, Status::PendingScore | Status::Held), "request is not on hold");
        self.do_rescue(id, env::predecessor_account_id());
    }

    /// Refresh the guardian set from the DAO's policy (members of `guardian_role`).
    pub fn sync_guardians(&mut self) -> Promise {
        ext_dao::ext(self.config.guardian_dao.clone())
            .with_static_gas(Gas::from_tgas(10))
            .get_policy()
            .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_policy())
    }

    #[private]
    pub fn on_policy(&mut self, #[callback_result] policy: Result<Value, PromiseError>) -> Vec<AccountId> {
        let policy = policy.unwrap_or_else(|_| env::panic_str("get_policy failed"));
        let mut found: Option<Vec<AccountId>> = None;
        if let Some(roles) = policy.get("roles").and_then(|r| r.as_array()) {
            for role in roles {
                if role.get("name").and_then(|n| n.as_str()) == Some(self.config.guardian_role.as_str()) {
                    let members = role
                        .get("kind")
                        .and_then(|k| k.get("Group"))
                        .and_then(|g| g.as_array())
                        .map(|a| a.iter().filter_map(|m| m.as_str()?.parse().ok()).collect::<Vec<AccountId>>());
                    found = members;
                }
            }
        }
        let members = found.unwrap_or_else(|| env::panic_str("guardian role not found or not a Group"));
        require!(!members.is_empty(), "guardian role is empty");
        self.guardians = members.clone();
        emit("guardians_synced", json!({ "dao": self.config.guardian_dao, "guardians": members, "needed": self.approvals_needed() }));
        members
    }

    pub fn dao_unfreeze(&mut self) {
        self.only_dao();
        self.frozen = false;
        emit("vault_unfrozen", json!({ "by": env::predecessor_account_id() }));
    }

    /// Safety-critical config can only change through the DAO.
    pub fn dao_update_config(&mut self, config: Config) {
        self.only_dao();
        Self::validate(&config);
        self.config = config;
        emit("config_updated", json!({ "by": env::predecessor_account_id() }));
    }

    /// Rewind the Sepolia nonce counter to the chain's confirmed nonce. Use when a signed tx can
    /// never be mined (for example a rescue larger than the balance left after gas) and blocks
    /// every later nonce. Signed but unbroadcast txs at or above `nonce` are marked superseded
    /// so the relayer skips them. Their old signatures stay valid, so only one tx per nonce can
    /// ever be mined. DAO only.
    pub fn dao_resync_evm_nonce(&mut self, nonce: u64) {
        self.only_dao();
        require!(nonce <= self.evm_nonce, "can only rewind the nonce");
        let mut superseded = vec![];
        for id in 0..self.next_id {
            let Some(mut r) = self.requests.get(&id).cloned() else { continue };
            let n = match &r.evm_tx {
                Some(t) => t.nonce,
                None => continue,
            };
            if n >= nonce && r.broadcast_hash.is_none() {
                r.broadcast_hash = Some(SUPERSEDED.to_string());
                self.requests.insert(id, r);
                superseded.push(id);
            }
        }
        let from = self.evm_nonce;
        self.evm_nonce = nonce;
        emit("evm_nonce_resynced", json!({ "from": from, "to": nonce, "superseded": superseded, "by": env::predecessor_account_id() }));
    }

    // ------------------------------------------------------------ owner tools

    /// Owner may only lower allowances (raising needs the DAO).
    pub fn tighten_allowance(&mut self, asset: Asset, limit: U128) {
        self.only_owner();
        let cfg = match asset {
            Asset::Near => &mut self.config.near_allowance,
            Asset::SepoliaEth => &mut self.config.eth_allowance,
        };
        require!(limit.0 <= cfg.limit.0, "owner can only lower the allowance");
        cfg.limit = limit;
        emit("allowance_tightened", json!({ "asset": asset, "limit": limit }));
    }

    /// Whitelisting is advisory input to the watcher (fresh entries still score risk).
    pub fn whitelist_add(&mut self, destination: String, label: Option<String>) {
        self.only_owner();
        let d = destination.to_lowercase();
        self.whitelist.insert(d.clone(), now_ms());
        emit("whitelist_added", json!({ "destination": d, "label": label.unwrap_or_default() }));
    }

    pub fn whitelist_remove(&mut self, destination: String) {
        self.only_owner();
        let d = destination.to_lowercase();
        self.whitelist.remove(&d);
        emit("whitelist_removed", json!({ "destination": d }));
    }

    /// Give an AI agent a function-call key on this vault that can only call
    /// `request_withdraw`. Requires a full-access-key call (1 yocto).
    #[payable]
    pub fn add_agent_key(&mut self, public_key: PublicKey, label: String) -> Promise {
        self.only_owner();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yocto");
        let pk_str = String::from(&public_key);
        self.agents.insert(pk_str.clone(), AgentInfo { label: label.clone(), added_ms: U64(now_ms()) });
        emit("agent_added", json!({ "public_key": pk_str, "label": label }));
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            Allowance::limited(NearToken::from_yoctonear(AGENT_KEY_ALLOWANCE)).unwrap(),
            env::current_account_id(),
            "request_withdraw".to_string(),
        )
    }

    #[payable]
    pub fn remove_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yocto");
        let pk_str = String::from(&public_key);
        self.agents.remove(&pk_str);
        emit("agent_removed", json!({ "public_key": pk_str }));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Relayer records the Sepolia tx hash after broadcasting a signed tx.
    pub fn record_broadcast(&mut self, id: u64, tx_hash: String) {
        let p = env::predecessor_account_id();
        require!(p == self.config.relayer || p == self.config.owner, "only relayer/owner");
        let mut req = self.get_req(id);
        require!(req.signature.is_some(), "not signed");
        req.broadcast_hash = Some(tx_hash.clone());
        self.requests.insert(id, req);
        emit("evm_broadcast", json!({ "id": id, "tx_hash": tx_hash }));
    }

    /// Retry the MPC signature for a request whose signing failed (same nonce + payload).
    pub fn retry_sign(&mut self, id: u64) -> Promise {
        let mut req = self.get_req(id);
        require!(
            matches!(req.status, Status::Failed | Status::Rescued) && req.evm_tx.is_some() && req.signature.is_none(),
            "nothing to retry"
        );
        if req.status == Status::Failed {
            req.status = Status::Executing;
        }
        let tx = req.evm_tx.clone().unwrap();
        self.requests.insert(id, req);
        self.sign_payload(id, &tx.payload_hex)
    }

    // ------------------------------------------------------------ cover pool

    /// Underwriters add NEAR to the cover pool.
    #[payable]
    pub fn cover_deposit(&mut self) {
        let amt = env::attached_deposit().as_yoctonear();
        require!(amt > 0, "attach NEAR");
        self.pool_balance += amt;
        let who = env::predecessor_account_id();
        let prev = self.underwriters.get(&who).copied().unwrap_or(0);
        self.underwriters.insert(who.clone(), prev + amt);
        emit("cover_deposit", json!({ "underwriter": who, "amount": U128(amt), "pool": U128(self.pool_balance) }));
    }

    pub fn quote_premium(&self, coverage: U128) -> U128 {
        let bps = self.premium_bps() as u128;
        let term_days = (self.config.cover.term_secs / 86_400).max(1) as u128;
        U128(coverage.0 * bps * term_days / 30 / 10_000)
    }

    /// Buy cover for losses inside the hot allowance (what holds cannot stop).
    #[payable]
    pub fn buy_cover(&mut self, coverage: U128) -> u64 {
        let premium = self.quote_premium(coverage).0;
        let paid = env::attached_deposit().as_yoctonear();
        require!(premium > 0 && paid >= premium, "attach at least the quoted premium");
        let exposure_after = self.active_exposure(now_ms()) + coverage.0.min(self.config.cover.per_incident_cap.0);
        require!(self.pool_balance + premium >= exposure_after / 2, "pool too thin: solvency would drop below 50%");
        let now = now_ms();
        let id = self.policies.len() as u64;
        let holder = env::predecessor_account_id();
        self.policies.push(Policy {
            id,
            holder: holder.clone(),
            coverage,
            premium: U128(premium),
            start_ms: U64(now),
            end_ms: U64(now + self.config.cover.term_secs * MS),
            paid_out: U128(0),
        });
        self.pool_balance += premium;
        if paid > premium {
            let _ = Promise::new(holder.clone()).transfer(NearToken::from_yoctonear(paid - premium));
        }
        emit("cover_bought", json!({ "policy": id, "holder": holder, "coverage": coverage, "premium": U128(premium) }));
        id
    }

    pub fn file_claim(&mut self, policy_id: u64, amount: U128, request_id: Option<u64>, reason: String) -> u64 {
        let p = self.policies.get(policy_id as u32).cloned().unwrap_or_else(|| env::panic_str("no policy"));
        require!(p.holder == env::predecessor_account_id(), "only the policy holder");
        require!(now_ms() <= p.end_ms.0, "policy expired");
        let id = self.claims.len() as u64;
        self.claims.push(Claim {
            id,
            policy_id,
            amount,
            request_id,
            reason: reason.chars().take(200).collect(),
            status: ClaimStatus::Pending,
            approvals: vec![],
            payout: U128(0),
        });
        emit("claim_filed", json!({ "claim": id, "policy": policy_id, "amount": amount, "request_id": request_id }));
        id
    }

    pub fn vote_claim(&mut self, claim_id: u64) {
        let voter = env::predecessor_account_id();
        require!(self.guardians.contains(&voter), "not a guardian");
        let needed = self.approvals_needed();
        let c = self.claims.get_mut(claim_id as u32).unwrap_or_else(|| env::panic_str("no claim"));
        require!(c.status == ClaimStatus::Pending, "claim closed");
        require!(!c.approvals.contains(&voter), "already voted");
        c.approvals.push(voter.clone());
        let count = c.approvals.len() as u32;
        emit("claim_vote", json!({ "claim": claim_id, "guardian": voter, "approvals": count, "needed": needed }));
        if count >= needed {
            self.pay_claim(claim_id);
        }
    }

    pub fn dao_approve_claim(&mut self, claim_id: u64) {
        self.only_dao();
        self.pay_claim(claim_id);
    }

    // ------------------------------------------------------------ views

    /// Contract version (set at build time with RR_VERSION).
    pub fn version(&self) -> &'static str {
        VERSION
    }

    /// Called by the new code after a DAO-driven upgrade. State layout is unchanged in v1.x.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let s: Self = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        emit("upgraded", json!({ "version": VERSION }));
        s
    }

    pub fn get_config(&self) -> &Config {
        &self.config
    }

    pub fn get_request(&self, id: u64) -> Option<Request> {
        self.requests.get(&id).cloned()
    }

    /// Newest first.
    pub fn list_requests(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Request> {
        let limit = limit.unwrap_or(20).min(100);
        let skip = from_index.unwrap_or(0);
        let mut out = vec![];
        let mut i = self.next_id.saturating_sub(skip);
        while i > 0 && (out.len() as u64) < limit {
            i -= 1;
            if let Some(r) = self.requests.get(&i) {
                out.push(r.clone());
            }
        }
        out
    }

    pub fn get_status(&self) -> VaultStatus {
        let now = now_ms();
        VaultStatus {
            near_balance: U128(env::account_balance().as_yoctonear()),
            near_available: U128(self.near_available()),
            near_hot_remaining: U128(self.hot_remaining(Asset::Near, now)),
            eth_hot_remaining: U128(self.hot_remaining(Asset::SepoliaEth, now)),
            frozen: self.frozen,
            next_request_id: self.next_id,
            evm_nonce: self.evm_nonce,
            guardians: self.guardians.clone(),
            approvals_needed: self.approvals_needed(),
            rescues: self.rescues,
        }
    }

    pub fn get_whitelist(&self) -> Vec<(String, U64)> {
        self.whitelist.iter().map(|(k, v)| (k.clone(), U64(*v))).collect()
    }

    pub fn get_agents(&self) -> Vec<(String, AgentInfo)> {
        self.agents.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn list_open(&self) -> Vec<u64> {
        self.open_ids.iter().copied().collect()
    }

    pub fn hold_secs_for(&self, score: u8) -> u64 {
        self.hold_for(score)
    }

    pub fn cover_stats(&self) -> CoverStats {
        let now = now_ms();
        let exposure = self.active_exposure(now);
        let solvency = if exposure == 0 { u32::MAX } else { (self.pool_balance * 10_000 / exposure).min(u32::MAX as u128) as u32 };
        CoverStats {
            pool_balance: U128(self.pool_balance),
            active_exposure: U128(exposure),
            solvency_bps: solvency,
            risk_points: self.risk_points(),
            premium_bps: self.premium_bps(),
            active_policies: self.policies.iter().filter(|p| p.end_ms.0 > now).count() as u32,
            per_incident_cap: self.config.cover.per_incident_cap,
        }
    }

    pub fn list_policies(&self) -> Vec<Policy> {
        self.policies.iter().cloned().collect()
    }

    pub fn list_claims(&self) -> Vec<Claim> {
        self.claims.iter().cloned().collect()
    }

    // ------------------------------------------------------------ callbacks

    #[private]
    pub fn on_near_sent(&mut self, id: u64, rescue: bool, #[callback_result] r: Result<(), PromiseError>) {
        let mut req = self.get_req(id);
        if r.is_ok() {
            if !rescue {
                req.status = Status::Executed;
            }
            emit(if rescue { "rescue_sent" } else { "withdraw_executed" }, json!({ "id": id, "asset": "Near" }));
        } else {
            if !rescue {
                req.status = Status::Failed;
            }
            emit("transfer_failed", json!({ "id": id, "rescue": rescue }));
        }
        self.requests.insert(id, req);
    }

    #[private]
    pub fn on_signed(&mut self, id: u64, #[callback_result] r: Result<SignatureResponse, PromiseError>) {
        let mut req = self.get_req(id);
        let rescue = req.status == Status::Rescued;
        match r {
            Ok(sig) => {
                req.signature = Some(MpcSignature { big_r: sig.big_r.affine_point, s: sig.s.scalar, recovery_id: sig.recovery_id });
                if !rescue {
                    req.status = Status::Executed;
                }
                emit("evm_signed", json!({ "id": id, "rescue": rescue, "payload": req.evm_tx.as_ref().map(|t| t.payload_hex.clone()) }));
            }
            Err(_) => {
                if !rescue {
                    req.status = Status::Failed;
                }
                emit("sign_failed", json!({ "id": id, "rescue": rescue }));
            }
        }
        self.requests.insert(id, req);
    }

    #[private]
    pub fn on_claim_paid(&mut self, claim_id: u64, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            let c = self.claims.get_mut(claim_id as u32).unwrap();
            let payout = c.payout.0;
            c.status = ClaimStatus::Pending;
            c.payout = U128(0);
            let policy_id = c.policy_id;
            self.pool_balance += payout;
            let p = self.policies.get_mut(policy_id as u32).unwrap();
            p.paid_out = U128(p.paid_out.0 - payout);
            emit("claim_payout_failed", json!({ "claim": claim_id }));
        }
    }

    // ------------------------------------------------------------ internals

    fn auth_requester(&self) -> (AccountId, Option<String>, Option<String>) {
        let p = env::predecessor_account_id();
        if p == self.config.owner {
            return (p, None, None);
        }
        if p == env::current_account_id() {
            let pk = String::from(&env::signer_account_pk());
            if let Some(a) = self.agents.get(&pk) {
                return (p, Some(a.label.clone()), Some(pk));
            }
        }
        env::panic_str("only owner or a registered agent key")
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.config.owner, "only owner");
    }

    fn only_dao(&self) {
        require!(env::predecessor_account_id() == self.config.guardian_dao, "only guardian DAO");
    }

    fn get_req(&self, id: u64) -> Request {
        self.requests.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such request"))
    }

    fn scaled(&self, secs: u64) -> u64 {
        secs / self.config.demo_time_divisor as u64
    }

    fn hold_for(&self, score: u8) -> u64 {
        let tier = self.config.hold_tiers.iter().rev().find(|t| score >= t.min_score).unwrap();
        self.scaled(tier.hold_secs.max(self.config.hold_floor_secs))
    }

    fn approvals_needed(&self) -> u32 {
        let n = self.guardians.len() as u32;
        let by_pct = (n * self.config.quorum_pct as u32 + 99) / 100;
        by_pct.max(self.config.min_distinct)
    }

    fn window<'a>(&'a mut self, asset: Asset) -> (&'a mut WindowState, AllowanceCfg) {
        match asset {
            Asset::Near => (&mut self.near_window, self.config.near_allowance.clone()),
            Asset::SepoliaEth => (&mut self.eth_window, self.config.eth_allowance.clone()),
        }
    }

    fn hot_remaining(&self, asset: Asset, now: u64) -> u128 {
        let (w, cfg) = match asset {
            Asset::Near => (&self.near_window, &self.config.near_allowance),
            Asset::SepoliaEth => (&self.eth_window, &self.config.eth_allowance),
        };
        let window_ms = self.scaled(cfg.window_secs) * MS;
        if now >= w.start_ms + window_ms {
            cfg.limit.0
        } else {
            cfg.limit.0.saturating_sub(w.spent)
        }
    }

    fn try_spend_allowance(&mut self, asset: Asset, amount: u128, now: u64) -> bool {
        let divisor = self.config.demo_time_divisor as u64;
        let (w, cfg) = self.window(asset);
        let window_ms = cfg.window_secs / divisor * MS;
        if now >= w.start_ms + window_ms {
            w.start_ms = now;
            w.spent = 0;
        }
        if w.spent + amount <= cfg.limit.0 {
            w.spent += amount;
            true
        } else {
            false
        }
    }

    fn near_available(&self) -> u128 {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(self.pool_balance)
            .saturating_sub(NEAR_BUFFER)
    }

    /// Send a request's funds (normal path).
    fn dispatch(&mut self, id: u64, _rescue: bool) {
        let req = self.get_req(id);
        match req.asset {
            Asset::Near => {
                require!(req.amount.0 <= self.near_available(), "insufficient vault NEAR");
                let to: AccountId = req.to.parse().unwrap();
                let _ = Promise::new(to)
                    .transfer(NearToken::from_yoctonear(req.amount.0))
                    .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(8)).on_near_sent(id, false));
            }
            Asset::SepoliaEth => {
                let to = req.to.clone();
                self.build_and_sign(id, &to, req.amount.0);
            }
        }
    }

    fn build_and_sign(&mut self, id: u64, to: &str, value: u128) {
        let e = self.config.evm.clone();
        let tx = evm::Eip1559Transfer {
            chain_id: e.chain_id,
            nonce: self.evm_nonce,
            max_priority_fee_per_gas: e.max_priority_fee_per_gas.0,
            max_fee_per_gas: e.max_fee_per_gas.0,
            gas_limit: e.gas_limit,
            to: evm::parse_address(to).unwrap(),
            value,
        };
        self.evm_nonce += 1;
        let unsigned = tx.unsigned_bytes();
        let payload = env::keccak256_array(&unsigned);
        let payload_hex = hex::encode(payload);
        let mut req = self.get_req(id);
        req.evm_tx = Some(EvmTx {
            chain_id: tx.chain_id,
            nonce: tx.nonce,
            max_priority_fee_per_gas: U128(tx.max_priority_fee_per_gas),
            max_fee_per_gas: U128(tx.max_fee_per_gas),
            gas_limit: tx.gas_limit,
            to: to.to_string(),
            value: U128(value),
            payload_hex: payload_hex.clone(),
            unsigned_hex: hex::encode(&unsigned),
        });
        self.requests.insert(id, req);
        emit("evm_sign_requested", json!({ "id": id, "nonce": tx.nonce, "to": to, "value": U128(value), "payload": payload_hex }));
        let _ = self.sign_payload(id, &payload_hex);
    }

    fn sign_payload(&self, id: u64, payload_hex: &str) -> Promise {
        ext_mpc::ext(self.config.evm.mpc_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .with_unused_gas_weight(1)
            .sign(SignRequest { path: self.config.evm.path.clone(), payload_v2: Payload::Ecdsa(payload_hex.to_string()), domain_id: 0 })
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .with_unused_gas_weight(0)
                    .on_signed(id),
            )
    }

    fn do_rescue(&mut self, id: u64, by: AccountId) {
        let mut req = self.get_req(id);
        req.status = Status::Rescued;
        req.resolved_by = Some(by.clone());
        let asset = req.asset;
        let amount = req.amount.0;
        let agent_pk = req.agent_pk.clone();
        self.requests.insert(id, req);
        self.open_ids.remove(&id);
        self.frozen = true;
        self.rescues += 1;
        // Block every other held request too: an attacker rarely sends just one.
        let others: Vec<u64> = self.open_ids.iter().copied().collect();
        for o in others {
            if let Some(mut r) = self.requests.get(&o).cloned() {
                r.status = Status::Cancelled;
                r.resolved_by = Some(by.clone());
                self.requests.insert(o, r);
                emit("request_cancelled", json!({ "id": o, "by": by, "reason": "rescue" }));
            }
        }
        self.open_ids.clear();
        // Revoke the agent key that made the rescued request.
        if let Some(pk) = agent_pk {
            if self.agents.remove(&pk).is_some() {
                emit("agent_revoked", json!({ "public_key": pk, "reason": "rescue" }));
                if let Ok(key) = pk.parse::<PublicKey>() {
                    let _ = Promise::new(env::current_account_id()).delete_key(key);
                }
            }
        }
        match asset {
            Asset::Near => {
                let sweep = self.near_available();
                emit("rescue_executed", json!({ "id": id, "by": by, "asset": asset, "safe": self.config.safe_near, "amount": U128(sweep) }));
                if sweep > 0 {
                    let _ = Promise::new(self.config.safe_near.clone())
                        .transfer(NearToken::from_yoctonear(sweep))
                        .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(8)).on_near_sent(id, true));
                }
            }
            Asset::SepoliaEth => {
                let safe = self.config.safe_evm.clone();
                emit("rescue_executed", json!({ "id": id, "by": by, "asset": asset, "safe": safe, "amount": U128(amount) }));
                self.build_and_sign(id, &safe, amount);
            }
        }
    }

    fn active_exposure(&self, now: u64) -> u128 {
        let cap = self.config.cover.per_incident_cap.0;
        self.policies
            .iter()
            .filter(|p| p.end_ms.0 > now)
            .map(|p| p.coverage.0.saturating_sub(p.paid_out.0).min(cap))
            .sum()
    }

    /// 0-100 risk points from the vault's own safety posture and recent history.
    fn risk_points(&self) -> u32 {
        let mut pts = 0u32;
        if self.guardians.len() < 3 {
            pts += 20;
        }
        if self.config.min_distinct < 2 {
            pts += 15;
        }
        let max_hold = self.config.hold_tiers.last().map(|t| t.hold_secs).unwrap_or(0);
        if max_hold < 3 * 3600 {
            pts += 15;
        }
        if !self.recent_scores.is_empty() {
            let avg = self.recent_scores.iter().map(|s| *s as u32).sum::<u32>() / self.recent_scores.len() as u32;
            pts += avg / 4;
        }
        pts += (self.rescues * 10).min(25);
        pts.min(100)
    }

    fn premium_bps(&self) -> u32 {
        self.config.cover.base_premium_bps * (100 + self.risk_points()) / 100
    }

    fn pay_claim(&mut self, claim_id: u64) {
        let cap = self.config.cover.per_incident_cap.0;
        let c = self.claims.get(claim_id as u32).cloned().unwrap_or_else(|| env::panic_str("no claim"));
        require!(c.status == ClaimStatus::Pending, "claim closed");
        let p = self.policies.get(c.policy_id as u32).cloned().unwrap();
        let remaining = p.coverage.0.saturating_sub(p.paid_out.0);
        let payout = c.amount.0.min(cap).min(remaining).min(self.pool_balance);
        require!(payout > 0, "nothing to pay");
        self.pool_balance -= payout;
        let pm = self.policies.get_mut(c.policy_id as u32).unwrap();
        pm.paid_out = U128(pm.paid_out.0 + payout);
        let cm = self.claims.get_mut(claim_id as u32).unwrap();
        cm.status = ClaimStatus::Paid;
        cm.payout = U128(payout);
        emit("claim_paid", json!({ "claim": claim_id, "holder": p.holder, "payout": U128(payout), "pool": U128(self.pool_balance) }));
        let _ = Promise::new(p.holder)
            .transfer(NearToken::from_yoctonear(payout))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(8)).on_claim_paid(claim_id));
    }
}

/// Upgrade entry point for Sputnik's `UpgradeRemote` proposal: the DAO calls this with the
/// new wasm as raw input. Only the guardian DAO may call it. Once the vault's own
/// full-access key is deleted, this is the only way to change the code.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn upgrade() {
    env::setup_panic_hook();
    let state: Vault = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
    require!(env::predecessor_account_id() == state.config.guardian_dao, "only guardian DAO");
    let code = env::input().unwrap_or_else(|| env::panic_str("no code"));
    require!(code.len() > 1024, "code too small");
    emit("upgrade_started", json!({ "code_sha256": hex::encode(env::sha256(&code)), "by": env::predecessor_account_id() }));
    let _ = Promise::new(env::current_account_id())
        .deploy_contract(code)
        .function_call("migrate".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(30));
}

#[cfg(test)]
mod tests;
