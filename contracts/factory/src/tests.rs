use super::*;
use near_sdk::test_utils::{get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = YOCTO;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("factory.testnet")).predecessor_account_id(acc(pred)).signer_account_id(acc(pred)).attached_deposit(NearToken::from_yoctonear(deposit));
    b
}

fn factory() -> Factory {
    testing_env!(ctx("deployer.testnet", 0).build());
    Factory::new(
        acc("dao.testnet"),
        Base58CryptoHash::from([7u8; 32]),
        Defaults {
            watcher: acc("watcher.testnet"),
            watcher_pk: "ed25519:11111111111111111111111111111111".into(),
            relayer: acc("relayer.testnet"),
            mpc_contract: acc("v1.signer-prod.testnet"),
            evm_path: "rescueroom-eth-1".into(),
            chain_id: 11_155_111,
            max_fee_per_gas: U128(2_000_000_000),
            max_priority_fee_per_gas: U128(200_000_000),
            gas_limit: 220_000,
            demo_guardians: vec![acc("g1.testnet"), acc("g2.testnet"), acc("g3.testnet")],
        },
        Costs { vault_storage: U128(NEAR / 20), registry_fee: U128(NEAR / 100), demo_deposit: U128(NEAR * 3 / 2) },
    )
}

fn setup() -> Setup {
    Setup {
        label: None,
        guardians: vec![acc("a.testnet"), acc("b.testnet"), acc("c.testnet")],
        guardian_dao: None,
        guardian_role: None,
        quorum_pct: 50,
        min_distinct: 2,
        safe_near: acc("cold.testnet"),
        safe_evm: None,
        near_allowance: U128(NEAR),
        near_window_secs: 86_400,
        eth_allowance: None,
        hold_tiers: vec![Tier { min_score: 0, hold_secs: 600 }, Tier { min_score: 60, hold_secs: 3_600 }],
        hold_floor_secs: 600,
        demo_clock: false,
    }
}

#[test]
fn builds_council_config_with_caller_as_owner() {
    let f = factory();
    let (c, g) = f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), setup());
    assert_eq!(c["owner"], "alice.testnet");
    assert_eq!(c["guardian_dao"], "x.factory.testnet"); // council mode
    assert_eq!(c["watcher"], "watcher.testnet");
    assert_eq!(c["safe_evm"], ZERO_EVM);
    assert_eq!(c["unscored_hold_secs"], 3_600);
    assert_eq!(c["demo_time_divisor"], 1);
    assert_eq!(g.len(), 3);
}

#[test]
fn dao_mode_keeps_the_dao() {
    let f = factory();
    let mut s = setup();
    s.guardian_dao = Some(acc("team.sputnik-v2.testnet"));
    s.guardian_role = Some("council".into());
    let (c, _) = f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
    assert_eq!(c["guardian_dao"], "team.sputnik-v2.testnet");
}

#[test]
#[should_panic(expected = "hold floor must be at least 60 seconds")]
fn hold_floor_minimum() {
    let f = factory();
    let mut s = setup();
    s.hold_floor_secs = 30;
    f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
}

#[test]
#[should_panic(expected = "hold floor must be at least 60 seconds")]
fn demo_clock_floor_is_real_time() {
    let f = factory();
    let mut s = setup();
    s.demo_clock = true; // 600 policy seconds = 10 real seconds
    f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
}

#[test]
#[should_panic(expected = "tiers: scores ascending")]
fn tiers_must_ascend() {
    let f = factory();
    let mut s = setup();
    s.hold_tiers = vec![Tier { min_score: 0, hold_secs: 3_600 }, Tier { min_score: 60, hold_secs: 600 }];
    f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
}

#[test]
#[should_panic(expected = "the owner cannot be a guardian")]
fn owner_is_not_a_guardian() {
    let f = factory();
    let mut s = setup();
    s.guardians.push(acc("alice.testnet"));
    f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
}

#[test]
#[should_panic(expected = "min_distinct must be")]
fn min_distinct_bounded() {
    let f = factory();
    let mut s = setup();
    s.min_distinct = 4;
    f.build(&acc("x.factory.testnet"), &acc("alice.testnet"), s);
}

#[test]
#[should_panic(expected = "attach at least")]
fn storage_must_be_paid() {
    let mut f = factory();
    testing_env!(ctx("alice.testnet", NEAR / 100).build());
    let _ = f.create_vault("alice".into(), setup());
}

#[test]
#[should_panic(expected = "attach at least")]
fn demo_needs_its_deposit() {
    let mut f = factory();
    testing_env!(ctx("alice.testnet", NEAR / 2).build());
    let _ = f.create_demo_vault("alice-demo".into());
}

#[test]
#[should_panic(expected = "name: 2-32 chars")]
fn bad_names_rejected() {
    let mut f = factory();
    testing_env!(ctx("alice.testnet", NEAR).build());
    let _ = f.create_vault("Alice.x".into(), setup());
}

#[test]
fn create_then_register_on_success() {
    let mut f = factory();
    testing_env!(ctx("alice.testnet", NEAR).build());
    let _ = f.create_vault("alice".into(), setup());
    let info = VaultInfo { vault: acc("alice.factory.testnet"), owner: acc("alice.testnet"), demo: false, council: true, created_ms: U64(0), label: "Vault".into(), alert_webhook: None };
    testing_env_with_promise_results(ctx("factory.testnet", 0).build(), PromiseResult::Successful(vec![]));
    assert!(f.on_created(info, acc("alice.testnet"), U128(NEAR)));
    assert_eq!(f.vaults_of(acc("alice.testnet")).len(), 1);
    assert_eq!(f.vault_count(), 1);
    assert!(get_logs().iter().any(|l| l.contains("vault_created")));
}

#[test]
fn failed_create_refunds_and_skips_registry() {
    let mut f = factory();
    let info = VaultInfo { vault: acc("alice.factory.testnet"), owner: acc("alice.testnet"), demo: false, council: true, created_ms: U64(0), label: "Vault".into(), alert_webhook: None };
    testing_env_with_promise_results(ctx("factory.testnet", 0).build(), PromiseResult::Failed);
    assert!(!f.on_created(info, acc("alice.testnet"), U128(NEAR)));
    assert_eq!(f.vault_count(), 0);
    assert!(get_logs().iter().any(|l| l.contains("vault_create_failed")));
}

#[test]
fn only_owner_sets_webhook() {
    let mut f = factory();
    let info = VaultInfo { vault: acc("alice.factory.testnet"), owner: acc("alice.testnet"), demo: false, council: true, created_ms: U64(0), label: "Vault".into(), alert_webhook: None };
    testing_env_with_promise_results(ctx("factory.testnet", 0).build(), PromiseResult::Successful(vec![]));
    f.on_created(info, acc("alice.testnet"), U128(NEAR));
    testing_env!(ctx("alice.testnet", 0).build());
    f.set_alert_webhook(acc("alice.factory.testnet"), Some("https://example.com/hook".into()));
    assert_eq!(f.get_vault(acc("alice.factory.testnet")).unwrap().alert_webhook.as_deref(), Some("https://example.com/hook"));
    testing_env!(ctx("mallory.testnet", 0).build());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_alert_webhook(acc("alice.factory.testnet"), None)));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "only the factory owner")]
fn costs_are_owner_only() {
    let mut f = factory();
    testing_env!(ctx("alice.testnet", 0).build());
    f.set_costs(Costs { vault_storage: U128(0), registry_fee: U128(0), demo_deposit: U128(0) });
}
