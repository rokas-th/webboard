#[path = "support/stub.rs"]
mod stub;

use chrono::NaiveDate;
use serde_json::{json, Value};
use stub::{fixture, Reply, Stub, OPM_PATH};
use tempfile::TempDir;
use webboard_core::holidays::{
    consumer_calendar_host, ics_days, HolidayDay, HolidayKind, Holidays, RegionRef, Sources,
    Subdivision, YearOut,
};
use webboard_core::CommandError;

const WEBBOARD_UA: &str = concat!(
    "WebBoard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://webboard.rokass.org)"
);

fn sources(stub: &Stub) -> Sources {
    let base = stub.base();
    Sources {
        openholidays: base.clone(),
        govuk: format!("{base}/bank-holidays.json"),
        opm: format!("{base}{OPM_PATH}"),
    }
}

fn service(stub: &Stub) -> (TempDir, Holidays) {
    let dir = TempDir::new().expect("temp dir");
    let holidays =
        Holidays::new(dir.path().join("holidays"), sources(stub)).expect("Holidays::new");
    (dir, holidays)
}

fn ch(subdivision: Option<&str>) -> RegionRef {
    RegionRef::Openholidays {
        country: "CH".into(),
        subdivision: subdivision.map(str::to_string),
    }
}

fn govuk(division: &str) -> RegionRef {
    RegionRef::Govuk {
        division: division.into(),
    }
}

fn err(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message)
}

fn day<'a>(days: &'a [HolidayDay], date: &str) -> &'a HolidayDay {
    days.iter()
        .find(|d| d.date == date)
        .unwrap_or_else(|| panic!("no holiday on {date}"))
}

fn dates(days: &[HolidayDay]) -> Vec<&str> {
    days.iter().map(|d| d.date.as_str()).collect()
}

fn oh_row(id: &str, date: &str, kind: &str, temporal: &str, codes: &[&str], name: &str) -> Value {
    json!({
        "id": id,
        "startDate": date,
        "endDate": date,
        "type": kind,
        "name": [{ "language": "EN", "text": name }],
        "regionalScope": "Regional",
        "temporalScope": temporal,
        "nationwide": false,
        "subdivisions": codes.iter().map(|c| json!({ "code": c, "shortName": c })).collect::<Vec<_>>(),
    })
}

fn ch_zh_with_extra_rows() -> Vec<u8> {
    let mut rows: Vec<Value> =
        serde_json::from_slice(&fixture("oh-CH-ZH-2026.json")).expect("recorded rows parse");
    assert_eq!(rows.len(), 13, "the recorded CH-ZH 2026 answer has 13 rows");
    rows.extend([
        oh_row(
            "bank-0000",
            "2026-06-01",
            "Bank",
            "FullDay",
            &["CH-ZH"],
            "Stub bank day",
        ),
        oh_row(
            "school-0000",
            "2026-07-13",
            "School",
            "FullDay",
            &["CH-ZH"],
            "Stub school day",
        ),
        oh_row(
            "bern-0000",
            "2026-03-02",
            "Public",
            "FullDay",
            &["CH-BE"],
            "Stub Bern day",
        ),
        oh_row(
            "eve-0000",
            "2026-12-24",
            "Public",
            "HalfDay",
            &["CH-ZH"],
            "Christmas Eve",
        ),
    ]);
    serde_json::to_vec(&rows).expect("rows serialise")
}

#[tokio::test]
async fn ch_zh_2026() {
    let stub = Stub::recorded();
    stub.set("/PublicHolidays", Reply::json(ch_zh_with_extra_rows()));
    let (_dir, h) = service(&stub);

    let out = h
        .year(&ch(Some("CH-ZH")), 2026, false)
        .await
        .expect("CH-ZH 2026");
    let days = &out.days;

    assert_eq!(days.len(), 14, "{:#?}", dates(days));
    for dropped in ["2026-06-01", "2026-07-13", "2026-03-02"] {
        assert!(!dates(days).contains(&dropped), "{dropped} was kept");
    }
    let public: Vec<&str> = days
        .iter()
        .filter(|d| d.kind == HolidayKind::Public)
        .map(|d| d.date.as_str())
        .collect();
    assert_eq!(public.len(), 10, "{public:?}");
    assert!(public.contains(&"2026-09-20"));

    let berchtold = day(days, "2026-01-02");
    assert_eq!(berchtold.name, "Berchtold's Day");
    assert_eq!(berchtold.kind, HolidayKind::Optional);

    for (date, name) in [
        ("2026-04-20", "Sechseläuten"),
        ("2026-09-14", "Knabenschiessen"),
    ] {
        let d = day(days, date);
        assert_eq!(d.name, name);
        assert_eq!(
            d.kind,
            HolidayKind::Half,
            "{name}: the recorded row is HalfDay"
        );
        assert_eq!(d.scope.as_deref(), Some("Zürich"), "{name}");
    }
    let eve = day(days, "2026-12-24");
    assert_eq!(eve.kind, HolidayKind::Half);
    assert_eq!(eve.source_id, "eve-0000");

    for d in days
        .iter()
        .filter(|d| d.date != "2026-04-20" && d.date != "2026-09-14")
    {
        assert_eq!(d.scope, None, "{}", d.date);
    }
    let recorded: Vec<Value> =
        serde_json::from_slice(&fixture("oh-CH-ZH-2026.json")).expect("recorded rows parse");
    for row in &recorded {
        let date = row["startDate"].as_str().expect("startDate");
        assert_eq!(day(days, date).source_id, row["id"].as_str().expect("id"));
    }
    assert_eq!(out.coverage, Some((2020, 2030)));
    assert!(!out.from_cache);

    let ph = stub
        .seen()
        .into_iter()
        .find(|s| s.path == "/PublicHolidays")
        .expect("a /PublicHolidays request");
    for part in [
        "countryIsoCode=CH",
        "subdivisionCode=CH-ZH",
        "validFrom=2026-01-01",
        "validTo=2026-12-31",
        "languageIsoCode=EN",
    ] {
        assert!(
            ph.query.split('&').any(|p| p == part),
            "{part} missing from {}",
            ph.query
        );
    }
    assert!(
        stub.seen().iter().all(|s| s.ua == WEBBOARD_UA),
        "{:?}",
        stub.seen()
    );
}

#[tokio::test]
async fn rate_limited_names_retry_after() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::status(429).header("Retry-After", "120"),
    );
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait 120 s before asking again (HTTP 429)."
        )
    );

    stub.set("/PublicHolidays", Reply::status(429));
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait before asking again (HTTP 429)."
        )
    );

    stub.set(
        "/PublicHolidays",
        Reply::status(429).header("Retry-After", "Wed, 11 Nov 2026 07:28:00 GMT"),
    );
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait until Wed, 11 Nov 2026 07:28:00 GMT before asking again (HTTP 429)."
        )
    );
}

#[tokio::test]
async fn unlisted_region_unsupported() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    let gb = RegionRef::Openholidays {
        country: "GB".into(),
        subdivision: None,
    };

    assert_eq!(
        h.year(&gb, 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list GB.")
    );
    assert_eq!(stub.requests_to("/Countries"), 1);
    assert_eq!(
        h.year(&gb, 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list GB.")
    );
    assert_eq!(
        stub.requests_to("/Countries"),
        2,
        "a country missing from the cached list refetches it once"
    );

    assert_eq!(
        h.year(&ch(Some("CH-XX")), 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list CH-XX.")
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 0);
}

#[tokio::test]
async fn beyond_coverage() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2031, false).await.unwrap_err(),
        err(
            "holidays.out_of_range",
            "OpenHolidays has CH holidays for 2020–2030, not 2031."
        )
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 0);
}

#[tokio::test]
async fn empty_listed_is_parse_error() {
    let stub = Stub::recorded();
    stub.set("/PublicHolidays", Reply::json(b"[]".to_vec()));
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.parse",
            "OpenHolidays returned no days for CH-ZH 2026 although it lists that region and year."
        )
    );
}

#[tokio::test]
async fn unreadable_answer_names_the_source() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::json(b"{\"not\": \"rows\"}".to_vec()),
    );
    let (_dir, h) = service(&stub);

    let e = h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err();
    assert_eq!(e.code, "holidays.parse");
    assert!(
        e.message
            .starts_with("OpenHolidays sent holidays WebBoard could not read: "),
        "{}",
        e.message
    );
}

fn has_descendant(s: &Subdivision, code: &str) -> bool {
    s.children
        .iter()
        .any(|c| c.code == code || has_descendant(c, code))
}

#[tokio::test]
async fn subdivisions_tree() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let tree = h.subdivisions("CH").await.expect("CH subdivisions");
    let zh = tree
        .iter()
        .find(|s| s.code == "CH-ZH")
        .expect("CH-ZH is top-level");
    assert_eq!(zh.name, "Zürich");
    assert!(has_descendant(zh, "CH-ZH-ZH-ZH"));
    assert_eq!(tree.len(), 26);
    let requests = stub.seen().len();
    assert_eq!(h.subdivisions("CH").await.expect("again"), tree);
    assert_eq!(
        stub.seen().len(),
        requests,
        "the second call reads the cache"
    );

    let gb = h.subdivisions("GB").await.expect("GB");
    assert_eq!(
        gb.iter()
            .map(|s| (s.code.as_str(), s.name.as_str()))
            .collect::<Vec<_>>(),
        [
            ("england-and-wales", "England and Wales"),
            ("scotland", "Scotland"),
            ("northern-ireland", "Northern Ireland"),
        ]
    );
    assert!(gb.iter().all(|s| s.children.is_empty()));
    assert_eq!(h.subdivisions("US").await.expect("US"), vec![]);
}

#[tokio::test]
async fn govuk_divisions() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let ew = h
        .year(&govuk("england-and-wales"), 2026, false)
        .await
        .expect("e&w");
    assert_eq!(ew.days.len(), 8);
    let boxing = day(&ew.days, "2026-12-28");
    assert_eq!(boxing.name, "Boxing Day (substitute day)");
    assert_eq!(boxing.source_id, "govuk:england-and-wales:2026-12-28");
    assert!(ew
        .days
        .iter()
        .all(|d| d.kind == HolidayKind::Public && d.scope.is_none()));
    assert_eq!(ew.coverage, Some((2019, 2028)));

    let scotland = h
        .year(&govuk("scotland"), 2026, false)
        .await
        .expect("scotland");
    assert_eq!(scotland.days.len(), 10);
    assert_eq!(
        day(&scotland.days, "2026-06-15").name,
        "World Cup bank holiday"
    );
    assert_eq!(scotland.coverage, Some((2019, 2028)));

    let ni = h
        .year(&govuk("northern-ireland"), 2026, false)
        .await
        .expect("ni");
    assert_eq!(ni.days.len(), 10);
    assert_eq!(ni.coverage, Some((2019, 2028)));
    assert_eq!(stub.requests_to("/bank-holidays.json"), 1);

    assert_eq!(
        h.year(&govuk("england-and-wales"), 2029, false)
            .await
            .unwrap_err(),
        err(
            "holidays.out_of_range",
            "GOV.UK has england-and-wales bank holidays for 2019–2028, not 2029."
        )
    );
    assert_eq!(
        h.year(&govuk("wales"), 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "GOV.UK does not list wales.")
    );
}

#[tokio::test]
async fn opm_browser_ua() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let out = h
        .year(&RegionRef::Opm, 2026, false)
        .await
        .expect("OPM 2026");
    assert_eq!(out.days.len(), 11, "{:?}", dates(&out.days));
    assert!(dates(&out.days).contains(&"2026-07-03"));
    let king = day(&out.days, "2026-01-19");
    assert_eq!(king.name, "Birthday of Martin Luther King, Jr.");
    assert_eq!(
        king.source_id,
        "bec3d912-9f9a-4d0b-9257-511e062e47c5@2026-01-19"
    );
    assert!(out.days.iter().all(|d| d.kind == HolidayKind::Public));
    assert_eq!(out.coverage, Some((2021, 2030)));
    assert_eq!(
        h.year(&RegionRef::Opm, 2031, false).await.unwrap_err(),
        err(
            "holidays.out_of_range",
            "OPM has US federal holidays for 2021–2030, not 2031."
        )
    );

    let seen = stub.seen();
    assert_eq!(
        seen.len(),
        2,
        "a cached feed that ends before 2031 is fetched once more"
    );
    assert!(
        seen.iter().all(|s| s.ua.starts_with("Mozilla/5.0")),
        "{seen:?}"
    );

    let today = NaiveDate::from_ymd_opt(2026, 11, 8).expect("date");
    let other = h
        .ics_preview(&format!("{}/ics/mixed.ics", stub.base()), today)
        .await
        .expect("an ICS feed other than OPM");
    assert!(!other.is_empty());
    assert_eq!(stub.seen().last().expect("a request").ua, WEBBOARD_UA);
    assert_eq!(
        h.ics_preview(&format!("{}{OPM_PATH}?copy=1", stub.base()), today)
            .await
            .unwrap_err(),
        err("holidays.http", "127.0.0.1 answered HTTP 403.")
    );
    assert_eq!(stub.seen().last().expect("a request").ua, WEBBOARD_UA);
}

fn mixed_url(stub: &Stub) -> String {
    format!("{}/ics/mixed.ics", stub.base())
}

#[tokio::test]
async fn ics_all_day_and_rrule() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    let region = RegionRef::Ics {
        url: mixed_url(&stub),
        name: "Company".into(),
    };

    let out = h.year(&region, 2026, false).await.expect("ICS 2026");
    assert_eq!(
        dates(&out.days),
        ["2026-03-01", "2026-12-28", "2026-12-29", "2026-12-30"]
    );
    assert_eq!(day(&out.days, "2026-03-01").name, "Company Day");
    assert_eq!(day(&out.days, "2026-12-29").name, "Year-end closure");
    assert!(out
        .days
        .iter()
        .all(|d| d.kind == HolidayKind::Public && d.scope.is_none()));
    assert_eq!(
        day(&out.days, "2026-03-01").source_id,
        "company-day@webboard.test@2026-03-01"
    );
    assert_eq!(
        day(&out.days, "2026-12-30").source_id,
        "year-end@webboard.test@2026-12-30"
    );
    assert_eq!(out.coverage, None, "a yearly rule has no last year");
}

#[test]
fn consumer_hosts_optional() {
    assert!(consumer_calendar_host(
        "https://calendar.google.com/calendar/ical/en.swiss%23holiday%40group.v.calendar.google.com/public/basic.ics"
    ));
    assert!(consumer_calendar_host(
        "https://calendars.icloud.com/holidays/ch_de.ics/"
    ));
    assert!(!consumer_calendar_host(
        "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/holidays.ics"
    ));

    let text = String::from_utf8(fixture("ics-mixed.ics")).expect("UTF-8");
    let days = ics_days(&text, 2026, true).expect("ics_days");
    assert_eq!(days.len(), 4);
    assert!(days.iter().all(|d| d.kind == HolidayKind::Optional));
    assert!(ics_days(&text, 2026, false)
        .expect("ics_days")
        .iter()
        .all(|d| d.kind == HolidayKind::Public));
}

#[test]
fn ics_without_all_day_events_is_parse_error() {
    let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:a@t\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260310T090000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    assert_eq!(
        ics_days(text, 2026, false).unwrap_err(),
        err("holidays.parse", "The calendar holds no all-day events.")
    );
}

#[tokio::test]
async fn ics_preview_window() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let preview = h
        .ics_preview(
            &mixed_url(&stub),
            NaiveDate::from_ymd_opt(2026, 11, 8).expect("date"),
        )
        .await
        .expect("preview");
    assert_eq!(
        preview.iter().map(|p| p.date.as_str()).collect::<Vec<_>>(),
        [
            "2026-03-01",
            "2026-12-28",
            "2026-12-29",
            "2026-12-30",
            "2027-03-01"
        ]
    );
    assert_eq!(preview[4].name, "Company Day");
}

#[tokio::test]
async fn cache_first_and_fresh() {
    let stub = Stub::recorded();
    let (dir, h) = service(&stub);
    let region = ch(Some("CH-ZH"));

    let first = h.year(&region, 2026, false).await.expect("first");
    assert!(!first.from_cache);
    let file = dir.path().join("holidays/openholidays/CH-ZH-2026.json");
    let stored: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("the year is cached")).expect("JSON");
    assert_eq!(stored["fetchedAt"], json!(first.fetched_at));
    assert!(stored["body"].is_string());
    assert!(
        chrono::DateTime::parse_from_rfc3339(&first.fetched_at)
            .is_ok_and(|t| t.offset().local_minus_utc() == 0),
        "{}",
        first.fetched_at
    );
    assert!(first.fetched_at.ends_with('Z'), "{}", first.fetched_at);

    let requests = stub.seen().len();
    let second = h.year(&region, 2026, false).await.expect("second");
    assert!(second.from_cache);
    assert_eq!(second.fetched_at, first.fetched_at);
    assert_eq!(second.days, first.days);
    assert_eq!(
        stub.seen().len(),
        requests,
        "the cached year makes no request"
    );

    let fresh = h.year(&region, 2026, true).await.expect("fresh");
    assert!(!fresh.from_cache);
    assert_eq!(stub.requests_to("/PublicHolidays"), 2);

    stub.stop();
    let e = h.year(&region, 2026, true).await.unwrap_err();
    assert_eq!(e.code, "holidays.offline", "{}", e.message);
    assert!(
        e.message.starts_with("Could not reach 127.0.0.1"),
        "{}",
        e.message
    );
    assert!(
        h.year(&region, 2026, false)
            .await
            .expect("cache")
            .from_cache
    );
}

#[test]
fn year_out_camel_case() {
    let v = serde_json::to_value(YearOut {
        days: vec![],
        fetched_at: "2026-11-08T14:05:00Z".into(),
        from_cache: true,
        coverage: Some((2020, 2030)),
    })
    .expect("serialise");
    let obj = v.as_object().expect("an object");
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["coverage", "days", "fetchedAt", "fromCache"]);
    assert!(keys.iter().all(|k| !k.contains('_')));
    assert_eq!(obj["coverage"], json!([2020, 2030]));
}

#[test]
fn holiday_types_match_the_contract() {
    let d = HolidayDay {
        date: "2026-04-20".into(),
        name: "Sechseläuten".into(),
        kind: HolidayKind::Half,
        source_id: "x".into(),
        scope: None,
    };
    assert_eq!(
        serde_json::to_value(&d).expect("serialise"),
        json!({ "date": "2026-04-20", "name": "Sechseläuten", "kind": "half", "sourceId": "x", "scope": null })
    );
    let regions: Vec<RegionRef> = serde_json::from_value(json!([
        { "src": "openholidays", "country": "CH", "subdivision": "CH-ZH" },
        { "src": "openholidays", "country": "AT", "subdivision": null },
        { "src": "govuk", "division": "scotland" },
        { "src": "opm" },
        { "src": "ics", "url": "https://example.test/a.ics", "name": "A" },
    ]))
    .expect("RegionRef deserialises from the TS shape");
    assert_eq!(regions[0], ch(Some("CH-ZH")));
    assert_eq!(regions[3], RegionRef::Opm);
    assert_eq!(
        serde_json::to_value(&regions[2]).expect("serialise"),
        json!({ "src": "govuk", "division": "scotland" })
    );
}

#[tokio::test]
async fn http_error_names_host() {
    let stub = Stub::recorded();
    stub.set("/Countries", Reply::status(503));
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.countries().await.unwrap_err(),
        err("holidays.http", "127.0.0.1 answered HTTP 503.")
    );
}

#[tokio::test]
async fn countries_merge() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let countries = h.countries().await.expect("countries");
    assert_eq!(countries.len(), 38);
    assert_eq!(
        countries.iter().filter(|c| c.src == "openholidays").count(),
        36
    );
    let ch = countries.iter().find(|c| c.code == "CH").expect("CH");
    assert_eq!(
        (ch.name.as_str(), ch.src.as_str()),
        ("Switzerland", "openholidays")
    );
    let tail: Vec<(&str, &str, &str)> = countries[36..]
        .iter()
        .map(|c| (c.code.as_str(), c.name.as_str(), c.src.as_str()))
        .collect();
    assert_eq!(
        tail,
        [
            ("GB", "United Kingdom", "govuk"),
            ("US", "United States (federal)", "opm"),
        ]
    );
}

fn this_year() -> i32 {
    use chrono::Datelike;
    chrono::Local::now().year()
}

fn live() -> (TempDir, Holidays) {
    let dir = TempDir::new().expect("temp dir");
    let h = Holidays::new(dir.path().join("holidays"), Sources::official()).expect("Holidays::new");
    (dir, h)
}

#[tokio::test]
#[ignore = "live network"]
async fn live_openholidays() {
    let (_dir, h) = live();
    let out = h
        .year(&ch(Some("CH-ZH")), this_year(), true)
        .await
        .expect("live CH-ZH");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_govuk() {
    let (_dir, h) = live();
    let out = h
        .year(&govuk("england-and-wales"), this_year(), true)
        .await
        .expect("live GOV.UK");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_opm() {
    let (_dir, h) = live();
    let out = h
        .year(&RegionRef::Opm, this_year(), true)
        .await
        .expect("live OPM");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_ics() {
    let (_dir, h) = live();
    let preview = h
        .ics_preview(&Sources::official().opm, chrono::Local::now().date_naive())
        .await
        .expect("live ICS preview");
    assert!(!preview.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn burst_openholidays() {
    use std::io::Write;
    let year = this_year();
    let client = reqwest::Client::builder()
        .user_agent(WEBBOARD_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("client");
    let url = format!("{}/PublicHolidays", Sources::official().openholidays);
    let (from, to) = (format!("{year}-01-01"), format!("{year}-12-31"));
    let mut lines = vec![format!(
        "\n## OpenHolidays burst, {} (30 sequential CH-ZH /PublicHolidays calls)\n",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    )];
    for n in 1..=30 {
        let resp = client
            .get(&url)
            .query(&[
                ("countryIsoCode", "CH"),
                ("subdivisionCode", "CH-ZH"),
                ("validFrom", from.as_str()),
                ("validTo", to.as_str()),
                ("languageIsoCode", "EN"),
            ])
            .send()
            .await
            .expect("burst request");
        let retry = match resp.headers().get("retry-after") {
            Some(v) => format!(" Retry-After: {}", v.to_str().expect("ASCII Retry-After")),
            None => String::new(),
        };
        lines.push(format!(
            "- call {n}: HTTP {}{retry}",
            resp.status().as_u16()
        ));
    }
    let probes = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.claude/docs/probes.md");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(probes)
        .expect("open probes.md");
    writeln!(file, "{}", lines.join("\n")).expect("append to probes.md");
}
