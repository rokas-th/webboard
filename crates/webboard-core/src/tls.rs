use rustls::crypto::{aws_lc_rs, CryptoProvider};

pub fn install_default_provider() -> Result<(), String> {
    ensure_default(aws_lc_rs::default_provider())
}

pub fn ensure_default(wanted: CryptoProvider) -> Result<(), String> {
    let Some(installed) = CryptoProvider::get_default() else {
        return wanted.clone().install_default().map_err(|_| {
            format!(
                "another TLS provider became the process default while WebBoard installed {:?}",
                wanted.key_provider
            )
        });
    };
    if format!("{installed:?}") == format!("{wanted:?}") {
        Ok(())
    } else {
        Err(format!(
            "the process-default TLS provider is {:?}, not the {:?} WebBoard uses",
            installed.key_provider, wanted.key_provider
        ))
    }
}
