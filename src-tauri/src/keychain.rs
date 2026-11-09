use webboard_core::sync::{SyncError, TokenStore};

const SERVICE: &str = "org.rokass.webboard";
const PROBE: &str = "probe";
#[cfg(any(target_os = "linux", test))]
const UNAVAILABLE: &str = "No Secret Service is running, so the device token cannot be stored. Start a Secret Service such as GNOME Keyring for this session, then set up sync again.";

pub struct OsKeychain;

fn account(space: &str) -> String {
    format!("space:{space}")
}

fn io(e: &keyring::Error) -> SyncError {
    SyncError::new("keychain.io", format!("The keychain failed: {e}"))
}

fn classify(e: keyring::Error) -> SyncError {
    match e {
        #[cfg(target_os = "linux")]
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            SyncError::new("keychain.unavailable", UNAVAILABLE)
        }
        other => io(&other),
    }
}

fn absent(r: keyring::Result<String>) -> Result<Option<String>, SyncError> {
    match r {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(classify(e)),
    }
}

fn entry(account: &str) -> Result<keyring::Entry, SyncError> {
    keyring::Entry::new(SERVICE, account).map_err(classify)
}

fn get_at(account: &str) -> Result<Option<String>, SyncError> {
    absent(entry(account)?.get_password())
}

fn put_at(account: &str, secret: &str) -> Result<(), SyncError> {
    entry(account)?.set_password(secret).map_err(classify)
}

fn delete_at(account: &str) -> Result<(), SyncError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(classify(e)),
    }
}

impl TokenStore for OsKeychain {
    fn probe(&self) -> Result<(), SyncError> {
        put_at(PROBE, PROBE)?;
        let read = get_at(PROBE)?;
        delete_at(PROBE)?;
        match read.as_deref() {
            Some(PROBE) => Ok(()),
            Some(_) => Err(SyncError::new(
                "keychain.io",
                "The keychain returned a different value than WebBoard stored.",
            )),
            None => Err(SyncError::new(
                "keychain.io",
                "The keychain lost a value WebBoard had just stored.",
            )),
        }
    }

    fn get(&self, space: &str) -> Result<Option<String>, SyncError> {
        get_at(&account(space))
    }

    fn put(&self, space: &str, token: &str) -> Result<(), SyncError> {
        put_at(&account(space), token)
    }

    fn delete(&self, space: &str) -> Result<(), SyncError> {
        delete_at(&account(space))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_entry_is_not_an_error() {
        assert_eq!(absent(Err(keyring::Error::NoEntry)), Ok(None));
        assert_eq!(absent(Ok("t".to_string())), Ok(Some("t".to_string())));
    }

    #[test]
    fn keychain_failures_are_named() {
        let failure = || keyring::Error::PlatformFailure("dbus said no".into());
        let no_access = || keyring::Error::NoStorageAccess("locked".into());
        if cfg!(target_os = "linux") {
            [failure(), no_access()].into_iter().for_each(|e| {
                assert_eq!(
                    classify(e),
                    SyncError::new("keychain.unavailable", UNAVAILABLE)
                )
            });
        } else {
            let e = classify(failure());
            assert_eq!(e.code, "keychain.io");
            assert!(e.message.contains("dbus said no"), "{}", e.message);
            assert_eq!(classify(no_access()).code, "keychain.io");
        }
        let e = classify(keyring::Error::TooLong("user".into(), 3));
        assert_eq!(e.code, "keychain.io");
        assert!(
            e.message.starts_with("The keychain failed: "),
            "{}",
            e.message
        );
    }

    #[test]
    fn tokens_live_under_the_webboard_service() {
        assert_eq!(SERVICE, "org.rokass.webboard");
        assert_eq!(account("sp000000000"), "space:sp000000000");
    }

    #[test]
    #[ignore = "touches the OS keychain; a rebuilt unsigned binary may need the owner's click"]
    fn os_keychain_round_trip() {
        let keychain = OsKeychain;
        let space = "webboard-keychain-test";
        keychain.probe().expect("probe");
        keychain.delete(space).expect("delete before");
        assert_eq!(keychain.get(space), Ok(None));
        keychain.put(space, "tok_ROUND_TRIP").expect("put");
        assert_eq!(keychain.get(space), Ok(Some("tok_ROUND_TRIP".to_string())));
        keychain.put(space, "tok_REPLACED").expect("put again");
        assert_eq!(keychain.get(space), Ok(Some("tok_REPLACED".to_string())));
        keychain.delete(space).expect("delete");
        assert_eq!(keychain.get(space), Ok(None));
        keychain.delete(space).expect("delete twice");
    }
}
