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

#[cfg(any(target_os = "linux", test))]
const MISSING_SERVICE: [&str; 4] = [
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.NoServer",
    "org.freedesktop.DBus.Error.FileNotFound",
];

#[cfg(any(target_os = "linux", test))]
fn names_a_missing_service(name: &str) -> bool {
    MISSING_SERVICE.contains(&name) || name.starts_with("org.freedesktop.DBus.Error.Spawn.")
}

#[cfg(target_os = "linux")]
fn no_secret_service(source: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    match source.downcast_ref::<dbus_secret_service::Error>() {
        Some(dbus_secret_service::Error::Unavailable) => true,
        Some(dbus_secret_service::Error::Dbus(e)) => e.name().is_some_and(names_a_missing_service),
        _ => false,
    }
}

#[cfg(any(target_os = "linux", test))]
fn secret_service_error(
    e: &keyring::Error,
    missing: impl FnOnce(&(dyn std::error::Error + Send + Sync + 'static)) -> bool,
) -> SyncError {
    match e {
        keyring::Error::NoStorageAccess(_) => SyncError::new(
            "keychain.unavailable",
            format!("The keyring is locked or refused access: {e}. Unlock it and try again."),
        ),
        keyring::Error::PlatformFailure(source) if missing(source.as_ref()) => SyncError::new(
            "keychain.unavailable",
            format!("{UNAVAILABLE} The keyring said: {e}"),
        ),
        keyring::Error::PlatformFailure(_) => {
            SyncError::new("keychain.io", format!("The keyring failed: {e}"))
        }
        _ => io(e),
    }
}

#[cfg(target_os = "linux")]
fn classify(e: keyring::Error) -> SyncError {
    secret_service_error(&e, no_secret_service)
}

#[cfg(not(target_os = "linux"))]
fn classify(e: keyring::Error) -> SyncError {
    io(&e)
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

fn probe_with(
    put: impl FnOnce() -> Result<(), SyncError>,
    get: impl FnOnce() -> Result<Option<String>, SyncError>,
    delete: impl FnOnce() -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    put()?;
    let read = get().and_then(|value| match value.as_deref() {
        Some(PROBE) => Ok(()),
        Some(_) => Err(SyncError::new(
            "keychain.io",
            "The keychain returned a different value than WebBoard stored.",
        )),
        None => Err(SyncError::new(
            "keychain.io",
            "The keychain lost a value WebBoard had just stored.",
        )),
    });
    match (read, delete()) {
        (Err(r), Err(d)) => Err(SyncError::new(
            r.code,
            format!(
                "{} The probe entry could not be removed: {}",
                r.message, d.message
            ),
        )),
        (Err(r), Ok(())) => Err(r),
        (Ok(()), Err(d)) => Err(d),
        (Ok(()), Ok(())) => Ok(()),
    }
}

impl TokenStore for OsKeychain {
    fn probe(&self) -> Result<(), SyncError> {
        probe_with(
            || put_at(PROBE, PROBE),
            || get_at(PROBE),
            || delete_at(PROBE),
        )
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
        assert_eq!(
            secret_service_error(&failure(), |_| true),
            SyncError::new(
                "keychain.unavailable",
                format!("{UNAVAILABLE} The keyring said: {}", failure())
            )
        );
        assert_eq!(
            secret_service_error(&failure(), |_| false),
            SyncError::new("keychain.io", format!("The keyring failed: {}", failure()))
        );
        assert_eq!(
            secret_service_error(&no_access(), |_| panic!("a locked keyring is not asked")),
            SyncError::new(
                "keychain.unavailable",
                format!(
                    "The keyring is locked or refused access: {}. Unlock it and try again.",
                    no_access()
                )
            )
        );
        assert_eq!(
            secret_service_error(&keyring::Error::NoEntry, |_| true),
            io(&keyring::Error::NoEntry)
        );
        let e = classify(keyring::Error::TooLong("user".into(), 3));
        assert_eq!(e.code, "keychain.io");
        assert!(
            e.message.starts_with("The keychain failed: "),
            "{}",
            e.message
        );
        if cfg!(not(target_os = "linux")) {
            let e = classify(failure());
            assert_eq!(e.code, "keychain.io");
            assert!(e.message.contains("dbus said no"), "{}", e.message);
            assert_eq!(classify(no_access()).code, "keychain.io");
        }
    }

    #[test]
    fn only_a_missing_bus_or_service_reads_as_no_secret_service() {
        [
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.NoServer",
            "org.freedesktop.DBus.Error.FileNotFound",
            "org.freedesktop.DBus.Error.Spawn.ExecFailed",
            "org.freedesktop.DBus.Error.Spawn.ChildExited",
        ]
        .into_iter()
        .for_each(|name| assert!(names_a_missing_service(name), "{name}"));
        [
            "org.freedesktop.DBus.Error.Failed",
            "org.freedesktop.DBus.Error.UnknownMethod",
            "org.freedesktop.DBus.Error.AccessDenied",
            "org.freedesktop.DBus.Error.NoReply",
            "org.freedesktop.DBus.Error.NotSupported",
            "org.freedesktop.Secret.Error.IsLocked",
            "org.freedesktop.Secret.Error.NoSuchObject",
        ]
        .into_iter()
        .for_each(|name| assert!(!names_a_missing_service(name), "{name}"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_variants_are_told_apart() {
        use dbus_secret_service::Error as Ss;
        let platform = |e: Ss| keyring::Error::PlatformFailure(Box::new(e));
        let dbus = |name: &str| Ss::Dbus(dbus::Error::new_custom(name, "said so"));
        [
            platform(Ss::Unavailable),
            platform(dbus("org.freedesktop.DBus.Error.ServiceUnknown")),
            platform(dbus("org.freedesktop.DBus.Error.NoServer")),
            platform(dbus("org.freedesktop.DBus.Error.Spawn.ExecFailed")),
        ]
        .into_iter()
        .for_each(|e| assert_eq!(classify(e).code, "keychain.unavailable"));
        [
            platform(Ss::Crypto("bad padding".into())),
            platform(Ss::Path("/bad".to_string())),
            platform(Ss::Parse),
            platform(Ss::UnsupportedSecretFormat),
            platform(dbus("org.freedesktop.DBus.Error.Failed")),
            platform(dbus("org.freedesktop.DBus.Error.UnknownMethod")),
            keyring::Error::PlatformFailure("not from the secret service".into()),
        ]
        .into_iter()
        .for_each(|e| {
            let shown = e.to_string();
            assert_eq!(
                classify(e),
                SyncError::new("keychain.io", format!("The keyring failed: {shown}"))
            );
        });
        [Ss::Locked, Ss::NoResult, Ss::Prompt]
            .into_iter()
            .for_each(|e| {
                assert_eq!(
                    classify(keyring::Error::NoStorageAccess(Box::new(e))).code,
                    "keychain.unavailable"
                )
            });
    }

    #[test]
    fn the_probe_always_removes_its_entry() {
        let deleted = std::cell::Cell::new(0);
        let failed_read = || Err(SyncError::new("keychain.io", "The keychain failed: read"));
        let delete_ok = || {
            deleted.set(deleted.get() + 1);
            Ok(())
        };
        assert_eq!(
            probe_with(|| Ok(()), failed_read, delete_ok),
            Err(SyncError::new("keychain.io", "The keychain failed: read"))
        );
        assert_eq!(deleted.get(), 1);
        assert_eq!(
            probe_with(
                || Ok(()),
                failed_read,
                || Err(SyncError::new("keychain.io", "The keychain failed: delete")),
            ),
            Err(SyncError::new(
                "keychain.io",
                "The keychain failed: read The probe entry could not be removed: The keychain failed: delete"
            ))
        );
        assert_eq!(
            probe_with(
                || Ok(()),
                || Ok(Some(PROBE.to_string())),
                || Err(SyncError::new("keychain.io", "The keychain failed: delete")),
            ),
            Err(SyncError::new("keychain.io", "The keychain failed: delete"))
        );
        assert_eq!(
            probe_with(
                || Ok(()),
                || Ok(Some("other".to_string())),
                || Err(SyncError::new("keychain.io", "The keychain failed: delete")),
            ),
            Err(SyncError::new(
                "keychain.io",
                "The keychain returned a different value than WebBoard stored. The probe entry could not be removed: The keychain failed: delete"
            ))
        );
        assert_eq!(
            probe_with(
                || Ok(()),
                || Ok(None),
                || Err(SyncError::new("keychain.io", "The keychain failed: delete")),
            ),
            Err(SyncError::new(
                "keychain.io",
                "The keychain lost a value WebBoard had just stored. The probe entry could not be removed: The keychain failed: delete"
            ))
        );
        assert_eq!(
            probe_with(|| Ok(()), || Ok(Some(PROBE.to_string())), delete_ok),
            Ok(())
        );
        assert_eq!(deleted.get(), 2);
        assert_eq!(
            probe_with(
                || Err(SyncError::new("keychain.unavailable", UNAVAILABLE)),
                || panic!("no read after a failed write"),
                || panic!("no delete after a failed write"),
            ),
            Err(SyncError::new("keychain.unavailable", UNAVAILABLE))
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
