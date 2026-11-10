#![cfg(not(target_vendor = "apple"))]

use rustls::crypto::{aws_lc_rs, CryptoProvider};
use webboard_core::tls::{ensure_default, install_default_provider};

#[test]
fn installs_aws_lc_rs_as_the_one_process_default_and_is_idempotent() {
    assert!(
        CryptoProvider::get_default().is_none(),
        "a TLS provider is already the process default before WebBoard installs one"
    );

    install_default_provider().expect("the first install sets the process default");
    let installed = CryptoProvider::get_default().expect("no process default after the install");
    assert_eq!(
        format!("{installed:?}"),
        format!("{:?}", aws_lc_rs::default_provider()),
        "the process default is not aws-lc-rs"
    );

    install_default_provider().expect("a second install of the same provider is a no-op");
    let again = CryptoProvider::get_default().expect("the process default went away");
    assert!(
        std::sync::Arc::ptr_eq(installed, again),
        "the second install replaced the process default"
    );

    let mut other = aws_lc_rs::default_provider();
    other.cipher_suites.truncate(1);
    let refused = ensure_default(other).expect_err("a different process default was accepted");
    assert!(
        refused.starts_with("the process-default TLS provider is AwsLcRs, not the AwsLcRs"),
        "{refused}"
    );
}
