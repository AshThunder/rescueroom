use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn watcher_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn cfg() -> Config {
    let pk = PublicKey::from_parts(CurveType::ED25519, watcher_key().verifying_key().to_bytes().to_vec()).unwrap();
    Config {
        owner: acc("owner.testnet"),
        guardian_dao: acc("dao.sputnik-v2.testnet"),
        guardian_role: "council".into(),
        quorum_pct: 50,
        min_distinct: 2,
        watcher: acc("watcher.testnet"),
        watcher_pk: pk,
        relayer: acc("relayer.testnet"),
        safe_near: acc("safe.testnet"),
        safe_evm: "0x000000000000000000000000000000000000dead".into(),
        near_allowance: AllowanceCfg { limit: U128(100 * NEAR), window_secs: 86_400 },
        eth_allowance: AllowanceCfg { limit: U128(10_000_000_000_000_000), window_secs: 86_400 },
        hold_tiers: vec![
            HoldTier { min_score: 0, hold_secs: 0 },
            HoldTier { min_score: 30, hold_secs: 3600 },
            HoldTier { min_score: 60, hold_secs: 3 * 3600 },
            HoldTier { min_score: 80, hold_secs: 6 * 3600 },
        ],
        hold_floor_secs: 0,
        unscored_hold_secs: 6 * 3600,
        evm: EvmCfg {
            mpc_contract: acc("v1.signer-prod.testnet"),
            path: "rescueroom-eth-1".into(),
            chain_id: 11_155_111,
            max_fee_per_gas: U128(50_000_000_000),
            max_priority_fee_per_gas: U128(2_000_000_000),
            gas_limit: 21_000,
        },
        cover: CoverCfg { base_premium_bps: 200, per_incident_cap: U128(50 * NEAR), term_secs: 30 * 86_400 },
        demo_time_divisor: 1,
    }
}

fn ctx(pred: &str, ts_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .account_balance(NearToken::from_yoctonear(5_000 * NEAR))
        .block_timestamp(ts_ms * 1_000_000);
    b
}

fn setup() -> Vault {
    testing_env!(ctx("deployer.testnet", 1_000).build());
    Vault::new(cfg(), vec![acc("g1.testnet"), acc("g2.testnet"), acc("g3.testnet")])
}

fn sign_score(id: u64, score: u8, conf: u8, hash: &str) -> String {
    let msg = score_message("vault.testnet", id, score, conf, hash);
    hex::encode(watcher_key().sign(msg.as_bytes()).to_bytes())
}

const H: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn score(v: &mut Vault, id: u64, s: u8, ts: u64) {
    testing_env!(ctx("watcher.testnet", ts).build());
    let sig = sign_score(id, s, 90, H);
    v.submit_score(id, s, 90, H.into(), vec![Signal { code: "new_destination".into(), weight: 30, detail: "never paid".into() }], sig);
}

#[test]
fn hot_spend_is_instant_and_large_is_held() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let a = v.request_withdraw(Asset::Near, "vendor.testnet".into(), U128(40 * NEAR), None);
    assert_eq!(v.get_request(a).unwrap().status, Status::Executing);
    assert!(v.get_request(a).unwrap().hot);
    let b = v.request_withdraw(Asset::Near, "vendor.testnet".into(), U128(70 * NEAR), None);
    let r = v.get_request(b).unwrap();
    assert_eq!(r.status, Status::PendingScore);
    assert_eq!(r.release_ms.0, 2_000 + 6 * 3600 * 1000);
    assert_eq!(v.get_status().near_hot_remaining.0, 60 * NEAR);
}

#[test]
fn allowance_window_resets() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    v.request_withdraw(Asset::Near, "a.testnet".into(), U128(100 * NEAR), None);
    testing_env!(ctx("owner.testnet", 2_000 + 86_400_000).build());
    let id = v.request_withdraw(Asset::Near, "a.testnet".into(), U128(100 * NEAR), None);
    assert!(v.get_request(id).unwrap().hot);
}

#[test]
fn score_sets_tiered_hold() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let ids: Vec<u64> = (0..4).map(|_| v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None)).collect();
    for (id, (s, hold)) in ids.iter().zip([(10u8, 0u64), (45, 3600), (70, 3 * 3600), (95, 6 * 3600)]) {
        score(&mut v, *id, s, 3_000);
        let r = v.get_request(*id).unwrap();
        assert_eq!(r.status, Status::Held);
        assert_eq!(r.release_ms.0, 2_000 + hold * 1000, "score {s}");
    }
    assert_eq!(v.hold_secs_for(29), 0);
    assert_eq!(v.hold_secs_for(30), 3600);
    assert_eq!(v.hold_secs_for(80), 6 * 3600);
}

#[test]
#[should_panic(expected = "bad evidence signature")]
fn forged_score_rejected() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    testing_env!(ctx("watcher.testnet", 3_000).build());
    let sig = sign_score(id, 90, 90, H); // signed 90, submits 5
    v.submit_score(id, 5, 90, H.into(), vec![], sig);
}

#[test]
#[should_panic(expected = "only watcher")]
fn only_watcher_scores() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    let sig = sign_score(id, 0, 90, H);
    v.submit_score(id, 0, 90, H.into(), vec![], sig);
}

#[test]
#[should_panic(expected = "still on hold")]
fn cannot_execute_during_hold() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    score(&mut v, id, 70, 3_000);
    testing_env!(ctx("anyone.testnet", 2_000 + 3 * 3600 * 1000 - 1).build());
    v.execute(id);
}

#[test]
fn execute_after_hold() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    score(&mut v, id, 70, 3_000);
    testing_env!(ctx("anyone.testnet", 2_000 + 3 * 3600 * 1000).build());
    v.execute(id);
    assert_eq!(v.get_request(id).unwrap().status, Status::Executing);
}

#[test]
fn unscored_request_waits_max_hold() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    testing_env!(ctx("anyone.testnet", 2_000 + 6 * 3600 * 1000).build());
    v.execute(id);
}

#[test]
fn owner_cancel() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "vendor.testnet".into(), U128(1_200 * NEAR), Some("invoice 88".into()));
    score(&mut v, id, 64, 3_000);
    testing_env!(ctx("owner.testnet", 4_000).build());
    v.cancel(id);
    assert_eq!(v.get_request(id).unwrap().status, Status::Cancelled);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"request_cancelled\"")));
}

#[test]
#[should_panic(expected = "only owner")]
fn stranger_cannot_cancel() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    testing_env!(ctx("g1.testnet", 2_000).build());
    v.cancel(id);
}

#[test]
#[should_panic(expected = "only owner or a registered agent key")]
fn stranger_cannot_request() {
    let mut v = setup();
    testing_env!(ctx("attacker.testnet", 2_000).build());
    v.request_withdraw(Asset::Near, "attacker.testnet".into(), U128(1), None);
}

#[test]
fn guardian_rescue_needs_quorum_and_distinct() {
    let mut v = setup();
    // 3 guardians, 50% -> 2, min_distinct 2 -> 2 needed
    assert_eq!(v.get_status().approvals_needed, 2);
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    score(&mut v, id, 92, 3_000);
    testing_env!(ctx("g1.testnet", 4_000).build());
    v.vote_rescue(id);
    assert_eq!(v.get_request(id).unwrap().status, Status::Held);
    testing_env!(ctx("g2.testnet", 5_000).build());
    v.vote_rescue(id);
    let r = v.get_request(id).unwrap();
    assert_eq!(r.status, Status::Rescued);
    assert!(v.get_status().frozen);
    assert!(get_logs().iter().any(|l| l.contains("rescue_executed") && l.contains("safe.testnet")));
}

#[test]
#[should_panic(expected = "already voted")]
fn guardian_double_vote_rejected() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    testing_env!(ctx("g1.testnet", 4_000).build());
    v.vote_rescue(id);
    v.vote_rescue(id);
}

#[test]
#[should_panic(expected = "vault is frozen")]
fn frozen_vault_blocks_requests() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    testing_env!(ctx("dao.sputnik-v2.testnet", 3_000).build());
    v.dao_rescue(id);
    testing_env!(ctx("owner.testnet", 4_000).build());
    v.request_withdraw(Asset::Near, "x.testnet".into(), U128(1), None);
}

#[test]
fn dao_unfreeze() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    testing_env!(ctx("dao.sputnik-v2.testnet", 3_000).build());
    v.dao_rescue(id);
    v.dao_unfreeze();
    assert!(!v.get_status().frozen);
}

#[test]
#[should_panic(expected = "owner can only lower")]
fn owner_cannot_raise_allowance() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    v.tighten_allowance(Asset::Near, U128(1_000 * NEAR));
}

#[test]
fn sync_guardians_parses_sputnik_policy() {
    let mut v = setup();
    let policy = json!({"roles":[
        {"name":"all","kind":"Everyone","permissions":["*:AddProposal"]},
        {"name":"council","kind":{"Group":["a.testnet","b.testnet","c.testnet","d.testnet"]},"permissions":["*:*"]}
    ]});
    testing_env!(ctx("vault.testnet", 2_000).predecessor_account_id(acc("vault.testnet")).build());
    let g = v.on_policy(Ok(policy));
    assert_eq!(g.len(), 4);
    assert_eq!(v.get_status().approvals_needed, 2);
}

#[test]
fn eth_request_builds_payload() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::SepoliaEth, "0x1111111111111111111111111111111111111111".into(), U128(1_000_000_000_000_000), None);
    let r = v.get_request(id).unwrap();
    assert!(r.hot);
    let tx = r.evm_tx.unwrap();
    assert_eq!(tx.nonce, 0);
    assert_eq!(tx.payload_hex.len(), 64);
    assert!(tx.unsigned_hex.starts_with("02"));
    assert_eq!(v.get_status().evm_nonce, 1);
}

#[test]
fn eth_rescue_signs_to_safe_address() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::SepoliaEth, "0x2222222222222222222222222222222222222222".into(), U128(50_000_000_000_000_000), None);
    assert_eq!(v.get_request(id).unwrap().status, Status::PendingScore);
    testing_env!(ctx("g1.testnet", 3_000).build());
    v.vote_rescue(id);
    testing_env!(ctx("g3.testnet", 3_000).build());
    v.vote_rescue(id);
    let r = v.get_request(id).unwrap();
    assert_eq!(r.status, Status::Rescued);
    assert_eq!(r.evm_tx.unwrap().to, "0x000000000000000000000000000000000000dead");
}

#[test]
fn cover_pool_flow() {
    let mut v = setup();
    testing_env!(ctx("underwriter.testnet", 2_000).attached_deposit(NearToken::from_yoctonear(100 * NEAR)).build());
    v.cover_deposit();
    let q = v.quote_premium(U128(80 * NEAR)).0;
    // base 200 bps, risk: max hold 6h (0), guardians 3 (0), distinct 2 (0) -> 200 bps
    assert_eq!(q, 80 * NEAR * 200 / 10_000);
    testing_env!(ctx("owner.testnet", 3_000).attached_deposit(NearToken::from_yoctonear(q)).build());
    let pid = v.buy_cover(U128(80 * NEAR));
    let st = v.cover_stats();
    assert_eq!(st.active_exposure.0, 50 * NEAR); // capped per incident
    assert_eq!(st.pool_balance.0, 100 * NEAR + q);
    assert!(st.solvency_bps > 20_000);
    testing_env!(ctx("owner.testnet", 4_000).build());
    let cid = v.file_claim(pid, U128(70 * NEAR), None, "hot allowance drained".into());
    testing_env!(ctx("g1.testnet", 5_000).build());
    v.vote_claim(cid);
    testing_env!(ctx("g2.testnet", 5_000).build());
    v.vote_claim(cid);
    let c = &v.list_claims()[0];
    assert_eq!(c.status, ClaimStatus::Paid);
    assert_eq!(c.payout.0, 50 * NEAR);
    assert_eq!(v.cover_stats().pool_balance.0, 50 * NEAR + q);
}

#[test]
fn risk_raises_premium() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let base = v.quote_premium(U128(10 * NEAR)).0;
    let id = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    score(&mut v, id, 100, 3_000);
    testing_env!(ctx("dao.sputnik-v2.testnet", 3_000).build());
    v.dao_rescue(id);
    assert!(v.quote_premium(U128(10 * NEAR)).0 > base);
}

#[test]
fn agent_key_requests_are_attributed() {
    let mut v = setup();
    let agent_pk = PublicKey::from_parts(CurveType::ED25519, vec![9u8; 32]).unwrap();
    testing_env!(ctx("owner.testnet", 2_000).attached_deposit(NearToken::from_yoctonear(1)).build());
    let _ = v.add_agent_key(agent_pk.clone(), "payroll-bot".into());
    testing_env!(ctx("vault.testnet", 3_000).signer_account_pk(agent_pk).build());
    let id = v.request_withdraw(Asset::Near, "vendor.testnet".into(), U128(5 * NEAR), None);
    assert_eq!(v.get_request(id).unwrap().agent.as_deref(), Some("payroll-bot"));
}

#[test]
fn demo_divisor_shortens_holds() {
    let mut c = cfg();
    c.demo_time_divisor = 60;
    testing_env!(ctx("deployer.testnet", 1_000).build());
    let v = Vault::new(c, vec![]);
    assert_eq!(v.hold_secs_for(45), 60);
    assert_eq!(v.hold_secs_for(85), 360);
}

#[test]
fn rescue_blocks_all_open_requests_and_revokes_agent() {
    let mut v = setup();
    let agent_pk = PublicKey::from_parts(CurveType::ED25519, vec![9u8; 32]).unwrap();
    testing_env!(ctx("owner.testnet", 2_000).attached_deposit(NearToken::from_yoctonear(1)).build());
    let _ = v.add_agent_key(agent_pk.clone(), "ops-agent".into());
    testing_env!(ctx("vault.testnet", 3_000).signer_account_pk(agent_pk.clone()).build());
    let a = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(500 * NEAR), None);
    let b = v.request_withdraw(Asset::Near, "drain.testnet".into(), U128(900 * NEAR), None);
    assert_eq!(v.list_open(), vec![a, b]);
    testing_env!(ctx("g1.testnet", 4_000).build());
    v.vote_rescue(b);
    testing_env!(ctx("g2.testnet", 4_000).build());
    v.vote_rescue(b);
    assert_eq!(v.get_request(b).unwrap().status, Status::Rescued);
    let ra = v.get_request(a).unwrap();
    assert_eq!(ra.status, Status::Cancelled);
    assert_eq!(ra.resolved_by.unwrap(), acc("g2.testnet"));
    assert!(v.list_open().is_empty());
    assert!(v.get_agents().is_empty());
    assert!(get_logs().iter().any(|l| l.contains("agent_revoked")));
}

#[test]
fn cancel_and_execute_leave_open_set() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let a = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    let b = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    v.cancel(a);
    score(&mut v, b, 0, 3_000);
    testing_env!(ctx("anyone.testnet", 3_000).build());
    v.execute(b);
    assert!(v.list_open().is_empty());
}

#[test]
fn hold_floor_stops_watcher_shortening_holds() {
    let mut c = cfg();
    c.hold_floor_secs = 1800;
    testing_env!(ctx("deployer.testnet", 1_000).build());
    let mut v = Vault::new(c, vec![acc("g1.testnet"), acc("g2.testnet")]);
    testing_env!(ctx("owner.testnet", 2_000).build());
    let id = v.request_withdraw(Asset::Near, "x.testnet".into(), U128(500 * NEAR), None);
    // A compromised watcher scores 0 to try to release instantly.
    score(&mut v, id, 0, 3_000);
    let r = v.get_request(id).unwrap();
    assert_eq!(r.release_ms.0, 2_000 + 1800 * 1000, "floor applies even at score 0");
    testing_env!(ctx("attacker.testnet", 2_000 + 1800 * 1000 - 1).build());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.execute(id)));
    assert!(res.is_err(), "cannot execute before the floor");
    // Higher tiers are unaffected when above the floor.
    assert_eq!(v.hold_secs_for(85), 6 * 3600);
    assert_eq!(v.hold_secs_for(0), 1800);
}

#[test]
#[should_panic(expected = "unscored hold must be >= hold floor")]
fn floor_cannot_exceed_unscored_hold() {
    let mut c = cfg();
    c.hold_floor_secs = 7 * 3600;
    testing_env!(ctx("deployer.testnet", 1_000).build());
    Vault::new(c, vec![]);
}

#[test]
#[should_panic(expected = "only guardian DAO")]
fn owner_cannot_change_config() {
    let mut v = setup();
    testing_env!(ctx("owner.testnet", 2_000).build());
    let mut c = cfg();
    c.hold_floor_secs = 0;
    v.dao_update_config(c);
}
